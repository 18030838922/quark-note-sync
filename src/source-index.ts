export interface SourceIndexEntry {
	accountKey: string;
	fid: string;
	name: string;
	size: number;
	localPath: string;
	sha256: string;
	downloadedAt: number;
}

export type SourceIndex = Record<string, SourceIndexEntry>;

export const QUARK_DOWNLOADS_DIRECTORY = 'Quark Downloads';
const ACCOUNT_KEY = /^[a-f\d]{64}$/i;
const SAFE_ID = /^[\w-]{1,128}$/;

export function sourceIndexKey(accountKey: string, fid: string): string {
	if (!ACCOUNT_KEY.test(accountKey) || !SAFE_ID.test(fid)) throw new Error('夸克引用账号或文件编号无效');
	return `${accountKey.toLowerCase()}/${fid}`;
}

export function normalizeSourceIndex(input: unknown): SourceIndex {
	const output = Object.create(null) as SourceIndex;
	const usedPaths = new Set<string>();
	if (!input || typeof input !== 'object' || Array.isArray(input)) return output;
	for (const [key, value] of Object.entries(input).slice(0, 10000)) {
		if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
		const item = value as Partial<SourceIndexEntry>;
		if (typeof item.accountKey !== 'string' || !ACCOUNT_KEY.test(item.accountKey) ||
			typeof item.fid !== 'string' || !SAFE_ID.test(item.fid) || !isSourceIndexKey(key, item.accountKey, item.fid) ||
			typeof item.name !== 'string' || !item.name.trim() || item.name.length > 255 || /[\r\n\u0000-\u001f]/.test(item.name) ||
			typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size < 0 ||
				typeof item.localPath !== 'string' || !isQuarkDownloadPath(item.localPath) ||
			typeof item.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(item.sha256) ||
			typeof item.downloadedAt !== 'number' || !Number.isSafeInteger(item.downloadedAt) || item.downloadedAt < 0) continue;
		const normalizedPath = normalizePathKey(item.localPath);
		if (usedPaths.has(normalizedPath)) continue;
		usedPaths.add(normalizedPath);
		output[key] = {
			accountKey: item.accountKey.toLowerCase(),
			fid: item.fid,
			name: item.name,
			size: item.size,
			localPath: item.localPath,
			sha256: item.sha256.toLowerCase(),
			downloadedAt: item.downloadedAt,
		};
	}
	return output;
}

export function managedDownloadPaths(index: SourceIndex): Set<string> {
	return new Set(Object.values(index).map((entry) => entry.localPath));
}

export function addSourceIndexEntry(index: SourceIndex, entry: SourceIndexEntry): SourceIndex {
	if (!ACCOUNT_KEY.test(entry.accountKey) || !SAFE_ID.test(entry.fid) || !isQuarkDownloadPath(entry.localPath)) {
		throw new Error('夸克下载索引无效');
	}
	const next = Object.assign(Object.create(null), index) as SourceIndex;
	const primaryKey = sourceIndexKey(entry.accountKey, entry.fid);
	const previous = next[primaryKey];
	if (previous && normalizePathKey(previous.localPath) !== normalizePathKey(entry.localPath)) {
		const baseAlias = `${primaryKey}#${encodeURIComponent(previous.localPath)}`;
		let alias = baseAlias;
		for (let suffix = 2; next[alias] && normalizePathKey(next[alias].localPath) !== normalizePathKey(previous.localPath); suffix += 1) {
			alias = `${baseAlias}#${suffix}`;
		}
		next[alias] ??= previous;
	}
	next[primaryKey] = {
		...entry,
		accountKey: entry.accountKey.toLowerCase(),
		sha256: entry.sha256.toLowerCase(),
	};
	return next;
}

export function moveSourceIndexPath(index: SourceIndex, oldPath: string, newPath: string): SourceIndex {
	const oldKey = normalizePathKey(oldPath);
	const newKey = normalizePathKey(newPath);
	const next = Object.assign(Object.create(null), index) as SourceIndex;
	const relinquished = new Set<string>();
	for (const [key, entry] of Object.entries(next)) {
		if (normalizePathKey(entry.localPath) !== oldKey) continue;
		if (!isQuarkDownloadPath(newPath)) {
			relinquished.add(sourceIndexKey(entry.accountKey, entry.fid));
			continue;
		}
		if (newKey !== oldKey) {
			const baseAlias = `${sourceIndexKey(entry.accountKey, entry.fid)}#${encodeURIComponent(entry.localPath)}`;
			let alias = baseAlias;
			for (let suffix = 2; next[alias] && normalizePathKey(next[alias].localPath) !== oldKey; suffix += 1) {
				alias = `${baseAlias}#${suffix}`;
			}
			next[alias] ??= entry;
		}
		const occupied = Object.values(next).some((other) =>
			normalizePathKey(other.localPath) === normalizePathKey(newPath) && other !== entry,
		);
		if (occupied) {
			delete next[key];
			continue;
		}
		next[key] = { ...entry, localPath: newPath };
	}
	for (const identity of relinquished) {
		for (const key of Object.keys(next)) {
			if (key === identity || key.startsWith(`${identity}#`)) delete next[key];
		}
	}
	return next;
}

export function chooseDownloadPath(name: string, existingPaths: Set<string>): string {
	const safeName = sanitizeName(name);
	const normalizedExisting = new Set([...existingPaths].map(normalizePathKey));
	const rootKey = normalizePathKey(QUARK_DOWNLOADS_DIRECTORY);
	if (normalizedExisting.has(rootKey)) throw new Error('Quark Downloads is occupied by a file; no file was overwritten');
	const extensionIndex = safeName.lastIndexOf('.');
	const stem = extensionIndex > 0 ? safeName.slice(0, extensionIndex) : safeName;
	const extension = extensionIndex > 0 ? safeName.slice(extensionIndex) : '';
	for (let suffix = 1; suffix <= 10000; suffix += 1) {
		const filename = suffix === 1 ? safeName : `${stem} (${suffix})${extension}`;
		const path = `${QUARK_DOWNLOADS_DIRECTORY}/${filename}`;
		const pathKey = normalizePathKey(path);
		const conflicts = [...normalizedExisting].some((existing) =>
			pathKey === existing || pathKey.startsWith(`${existing}/`) || existing.startsWith(`${pathKey}/`),
		);
		if (!conflicts) {
			try {
				validateVaultPath(path);
				return path;
			} catch {
				// Keep trying with a safe numbered filename.
			}
		}
	}
	throw new Error('夸克下载文件重名过多，无法安全保存');
}

function sanitizeName(name: string): string {
	let safe = name
		.normalize('NFKC')
		.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
		.replace(/[ .]+$/g, '')
		.trim();
	if (!safe || safe === '.' || safe === '..') return 'download';
	if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)) safe = `_${safe}`;
	return safe.slice(0, 180);
}

function isQuarkDownloadPath(path: string): boolean {
	if (path.includes('\\') || /[\u0000-\u001f]/.test(path)) return false;
	const segments = path.split('/');
	if (segments.length !== 2 || segments[0].normalize('NFKC').toLowerCase() !== QUARK_DOWNLOADS_DIRECTORY.toLowerCase() ||
		segments[1] === '' || segments[1] === '.' || segments[1] === '..') return false;
	try {
		validateVaultPath(path);
		return true;
	} catch {
		return false;
	}
}

function normalizePathKey(path: string): string {
	return path.replace(/\\/g, '/').normalize('NFKC').toLowerCase();
}

function isSourceIndexKey(key: string, accountKey: string, fid: string): boolean {
	const primary = sourceIndexKey(accountKey, fid);
	return key === primary || (key.startsWith(`${primary}#`) && key.length <= 1024);
}
import { validateVaultPath } from './core.ts';
