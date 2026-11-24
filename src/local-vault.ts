import type { App, TAbstractFile, TFile, TFolder } from 'obsidian';
import { isSyncablePath, MAX_FILE_BYTES, validatePathSet, validateVaultPath } from './core.ts';
import { sha256Hex } from './hash.ts';
import type { LocalFileState } from './sync-engine.ts';

export const CONFLICT_DIRECTORY = '.quark-sync-conflicts';

export interface LocalScan {
	files: LocalFileState[];
	presentPaths: string[];
	protectedPaths: Map<string, string>;
}

export interface LocalContent {
	bytes: Uint8Array;
	sha256: string;
}

export class LocalVaultAdapter {
	private readonly app: App;

	constructor(app: App) {
		this.app = app;
	}

	async scan(configDir: string): Promise<LocalScan> {
		const files: LocalFileState[] = [];
		const presentPaths: string[] = [];
		const protectedPaths = new Map<string, string>();
		for (const file of this.app.vault.getFiles()) {
			if (
				isWithinDirectory(file.path, configDir) ||
				isWithinDirectory(file.path, '.trash') ||
				isWithinDirectory(file.path, CONFLICT_DIRECTORY)
			) continue;
			presentPaths.push(file.path);
			if (file.stat.size > MAX_FILE_BYTES) {
				protectedPaths.set(file.path, '文件超过 10 MiB，已跳过且不会同步删除');
				continue;
			}
			if (!isSyncablePath(file.path, file.stat.size, configDir)) {
				protectedPaths.set(file.path, '路径或文件大小不符合同步规则，已跳过');
				continue;
			}
			try {
				const bytes = toBytes(await this.app.vault.readBinary(file));
				if (bytes.byteLength !== file.stat.size || bytes.byteLength > MAX_FILE_BYTES) {
					protectedPaths.set(file.path, '读取期间文件大小发生变化，已跳过');
					continue;
				}
				const sha256 = await sha256Hex(bytes);
				files.push({ path: file.path, sha256, size: bytes.byteLength });
			} catch {
				protectedPaths.set(file.path, '本地文件读取失败，已跳过且不会同步删除');
			}
		}
		return { files, presentPaths, protectedPaths };
	}

	async read(path: string): Promise<LocalContent | null> {
		const abstract = this.app.vault.getAbstractFileByPath(path);
		if (isWithinDirectory(path, CONFLICT_DIRECTORY) || !abstract) {
			if (!(await this.app.vault.adapter.exists(path))) return null;
			const stat = await this.app.vault.adapter.stat(path);
			if (stat?.type !== 'file') throw new Error(`本地路径已被目录占用：${path}`);
			const bytes = toBytes(await this.app.vault.adapter.readBinary(path));
			return { bytes, sha256: await sha256Hex(bytes) };
		}
		if (!isTFile(abstract)) throw new Error(`本地路径已被目录占用：${path}`);
		const bytes = toBytes(await this.app.vault.readBinary(abstract));
		return { bytes, sha256: await sha256Hex(bytes) };
	}

	async currentHash(path: string): Promise<string | null> {
		return (await this.read(path))?.sha256 ?? null;
	}

	async write(
		path: string,
		bytes: Uint8Array,
		configDir: string,
		allowConflict = false,
		expectedCurrentHash?: string | null,
	): Promise<void> {
		const relative = allowConflict ? relativeConflictPath(path) : path;
		validateVaultPath(relative);
		if (!allowConflict) validatePathSet([path], configDir);
		if (bytes.byteLength > MAX_FILE_BYTES) throw new Error(`本地写入超过 10 MiB：${path}`);
		if (allowConflict) {
			if (await this.app.vault.adapter.exists(path)) throw new Error(`冲突副本路径已出现：${path}`);
			await this.ensureParentFolders(path, true);
			if (await this.app.vault.adapter.exists(path)) throw new Error(`冲突副本路径已出现：${path}`);
			await this.app.vault.adapter.writeBinary(path, toArrayBuffer(bytes));
			return;
		}
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (isTFolder(existing)) throw new Error(`本地目录占用了文件路径：${path}`);
		if (existing && !isTFile(existing)) throw new Error(`本地路径类型无法确认：${path}`);
		if (isTFile(existing)) {
			if (expectedCurrentHash !== undefined && await this.currentHash(path) !== expectedCurrentHash) {
				throw new Error(`本地文件已变化，拒绝覆盖：${path}`);
			}
			await this.app.vault.modifyBinary(existing, toArrayBuffer(bytes));
			return;
		}
		if (await this.app.vault.adapter.exists(path)) throw new Error(`本地未索引文件占用了路径：${path}`);
		await this.ensureParentFolders(path, allowConflict);
		const raced = this.app.vault.getAbstractFileByPath(path);
		if (raced || await this.app.vault.adapter.exists(path)) throw new Error(`写入前本地路径已出现：${path}`);
		if (expectedCurrentHash !== undefined && await this.currentHash(path) !== expectedCurrentHash) {
			throw new Error(`本地文件已变化，拒绝覆盖：${path}`);
		}
		await this.app.vault.createBinary(path, toArrayBuffer(bytes));
	}

	async trash(path: string, configDir: string, expectedCurrentHash?: string | null): Promise<void> {
		validatePathSet([path], configDir);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (!existing) return;
		if (!isTFile(existing)) throw new Error(`本地目录占用了文件路径：${path}`);
		if (expectedCurrentHash !== undefined && await this.currentHash(path) !== expectedCurrentHash) {
			throw new Error(`本地文件已变化，拒绝删除：${path}`);
		}
		await this.app.vault.trash(existing, false);
	}

	listPaths(configDir: string): string[] {
		return this.app.vault.getFiles()
			.filter((file) =>
				!isWithinDirectory(file.path, configDir) &&
				!isWithinDirectory(file.path, '.trash') &&
				!isWithinDirectory(file.path, CONFLICT_DIRECTORY),
			)
			.map((file) => file.path);
	}

	async listConflictRelativePaths(): Promise<string[]> {
		if (!(await this.app.vault.adapter.exists(CONFLICT_DIRECTORY))) return [];
		const result: string[] = [];
		const walk = async (directory: string): Promise<void> => {
			const listing = await this.app.vault.adapter.list(directory);
			for (const file of listing.files) result.push(file.slice(CONFLICT_DIRECTORY.length + 1));
			for (const folder of listing.folders) await walk(folder);
		};
		await walk(CONFLICT_DIRECTORY);
		return result;
	}

	async hasConflictDirectory(): Promise<boolean> {
		if (!(await this.app.vault.adapter.exists(CONFLICT_DIRECTORY))) return false;
		const stat = await this.app.vault.adapter.stat(CONFLICT_DIRECTORY);
		if (stat?.type !== 'folder') throw new Error('本地冲突目录名被文件占用');
		return true;
	}

	async ensureDirectoriesForFile(path: string, allowConflict = false): Promise<void> {
		const segments = path.split('/');
		segments.pop();
		let current = '';
		for (const segment of segments) {
			current = current ? `${current}/${segment}` : segment;
			if (allowConflict) {
				if (await this.app.vault.adapter.exists(current)) {
					const stat = await this.app.vault.adapter.stat(current);
					if (stat?.type !== 'folder') throw new Error(`本地文件占用了目录路径：${current}`);
					continue;
				}
				try {
					await this.app.vault.adapter.mkdir(current);
				} catch {
					if (!(await this.app.vault.adapter.exists(current))) throw new Error(`无法创建本地目录：${current}`);
				}
				continue;
			}
			const existing = this.app.vault.getAbstractFileByPath(current);
			if (isTFolder(existing)) continue;
			if (existing) throw new Error(`本地文件占用了目录路径：${current}`);
			if (!allowConflict && current.toLowerCase() === CONFLICT_DIRECTORY) {
				throw new Error('冲突目录不能作为普通同步目标');
			}
			try {
				await this.app.vault.createFolder(current);
			} catch {
				const raced = this.app.vault.getAbstractFileByPath(current);
				if (!isTFolder(raced)) throw new Error(`无法创建本地目录：${current}`);
			}
		}
	}

	private async ensureParentFolders(path: string, allowConflict: boolean): Promise<void> {
		await this.ensureDirectoriesForFile(path, allowConflict);
	}
}

export function isWithinDirectory(path: string, directory: string): boolean {
	const normalizedPath = path.replace(/\\/g, '/').normalize('NFKC').toLowerCase();
	const normalizedDirectory = directory.replace(/\\/g, '/').replace(/\/$/, '').normalize('NFKC').toLowerCase();
	return normalizedPath === normalizedDirectory || normalizedPath.startsWith(`${normalizedDirectory}/`);
}

export function toBytes(input: ArrayBuffer | Uint8Array): Uint8Array {
	return input instanceof Uint8Array ? new Uint8Array(input) : new Uint8Array(input);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function relativeConflictPath(path: string): string {
	const prefix = `${CONFLICT_DIRECTORY}/`;
	if (!path.startsWith(prefix)) throw new Error('冲突副本路径无效');
	return path.slice(prefix.length);
}

function isTFile(value: TAbstractFile | null): value is TFile {
	return value !== null && 'stat' in value && 'extension' in value;
}

function isTFolder(value: TAbstractFile | null): value is TFolder {
	return value !== null && 'children' in value && Array.isArray(value.children);
}
