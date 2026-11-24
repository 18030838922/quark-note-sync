export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export interface VersionEvent {
	id: string;
	path: string;
	kind: 'file' | 'delete';
	parents: string[];
	deviceId: string;
	createdAt: number;
	sha256?: string;
	size?: number;
}

export interface ResolvedPath {
	heads: VersionEvent[];
	winner?: VersionEvent;
	conflictCopies: VersionEvent[];
	deleted: boolean;
	concurrent: boolean;
}

export class IncompleteHistoryError extends Error {
	constructor(message = '夸克同步历史不完整，已暂停合并') {
		super(message);
		this.name = 'IncompleteHistoryError';
	}
}

/** Resolve one path's immutable event history without relying on arrival order. */
export function resolvePathEvents(events: VersionEvent[]): ResolvedPath {
	if (events.length === 0) throw new IncompleteHistoryError('该路径没有可用的版本记录');
	const byId = new Map<string, VersionEvent>();
	for (const event of events) {
		if (!event.id || byId.has(event.id)) throw new IncompleteHistoryError('发现重复或无效的版本编号');
		if (event.path !== events[0].path) throw new IncompleteHistoryError('版本记录跨越了多个路径');
		if (event.kind === 'file' && !event.sha256) throw new IncompleteHistoryError('文件版本缺少 SHA-256');
		if (event.kind === 'file' && (!Number.isSafeInteger(event.size) || (event.size ?? -1) < 0 || (event.size ?? MAX_FILE_BYTES + 1) > MAX_FILE_BYTES)) {
			throw new IncompleteHistoryError('文件版本超过大小上限');
		}
		if (new Set(event.parents).size !== event.parents.length) throw new IncompleteHistoryError('版本记录包含重复父版本');
		byId.set(event.id, event);
	}
	const children = new Map<string, string[]>();
	const remainingParents = new Map<string, number>();
	for (const event of events) {
		for (const parent of event.parents) {
			const parentEvent = byId.get(parent);
			if (!parentEvent || parentEvent.path !== event.path) throw new IncompleteHistoryError();
			if (parent === event.id) throw new IncompleteHistoryError('版本记录形成循环，已暂停合并');
			children.set(parent, [...(children.get(parent) ?? []), event.id]);
		}
		remainingParents.set(event.id, event.parents.length);
	}
	const ready = events.filter((event) => event.parents.length === 0).map((event) => event.id);
	let visited = 0;
	while (ready.length > 0) {
		const id = ready.pop()!;
		visited += 1;
		for (const childId of children.get(id) ?? []) {
			const remaining = (remainingParents.get(childId) ?? 0) - 1;
			remainingParents.set(childId, remaining);
			if (remaining === 0) ready.push(childId);
		}
	}
	if (visited !== events.length) throw new IncompleteHistoryError('版本记录形成循环，已暂停合并');

	const referenced = new Set(events.flatMap((event) => event.parents));
	const heads = events
		.filter((event) => !referenced.has(event.id))
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	if (heads.length === 0) throw new IncompleteHistoryError('版本记录形成循环，已暂停合并');

	const contentHeads = heads.filter((event) => event.kind === 'file');
	const uniqueContentHeads = contentHeads.filter((event, index, versions) =>
		versions.findIndex((candidate) => candidate.sha256 === event.sha256) === index,
	);
	const winner = uniqueContentHeads[0];
	return {
		heads,
		winner,
		conflictCopies: uniqueContentHeads.slice(1),
		deleted: contentHeads.length === 0,
		concurrent: heads.length > 1,
	};
}

/** Return a normalized relative vault path or reject paths that can escape or target local state. */
/** Check ASCII control codes before using a value in a path, token or request header. */
export function hasAsciiControl(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code < 32 || code === 127) return true;
	}
	return false;
}

export function validateVaultPath(input: string): string {
	if (typeof input !== 'string' || input.length === 0 || input.startsWith('/') || input.startsWith('\\')) {
		throw new Error('无效的同步路径');
	}
	if (input.includes('\\')) throw new Error('同步路径不能包含 Windows 路径分隔符');
	const path = input;
	const parts = path.split('/');
	if (
		parts.some((part) =>
			part.length === 0 ||
			part === '.' ||
			part === '..' ||
			/[<>:"|?*]/.test(part) || hasAsciiControl(part) ||
			/[ .]$/.test(part) ||
			/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(part.normalize('NFKC').split('.')[0].trimEnd()),
		) ||
		['.trash', '.quark-sync-conflicts', '.quark-note-sync'].includes(parts[0].normalize('NFKC').toLowerCase())
	) {
		throw new Error('同步路径不能指向上级目录、配置或本地冲突文件夹');
	}
	return path;
}

/** Reject names that alias on Windows or that would make a file overwrite a directory. */
export function validatePathSet(paths: string[], configDir: string): string[] {
	const normalized = new Map<string, string>();
	const normalizedDirectories = new Map<string, string>();
	const valid = paths.map(validateVaultPath);
	const configKey = configDir.replace(/\\/g, '/').replace(/\/$/, '').normalize('NFKC').toLowerCase();
	for (const path of valid) {
		const key = path.normalize('NFKC').toLowerCase();
		if (key === configKey || key.startsWith(`${configKey}/`)) throw new Error(`同步路径不能指向配置目录：${path}`);
		const previous = normalized.get(key);
		if (previous) throw new Error(`路径冲突：${previous} 与 ${path}`);
		normalized.set(key, path);
		const parts = path.split('/');
		for (let index = 1; index < parts.length; index += 1) {
			const originalDirectory = parts.slice(0, index).join('/');
			const directoryKey = originalDirectory.normalize('NFKC').toLowerCase();
			const previousDirectory = normalizedDirectories.get(directoryKey);
			if (previousDirectory && previousDirectory !== originalDirectory) {
				throw new Error(`路径冲突：目录 ${previousDirectory} 与 ${originalDirectory} 在 Windows 上相同`);
			}
			normalizedDirectories.set(directoryKey, originalDirectory);
		}
	}
	for (const path of valid) {
		const parts = path.split('/');
		for (let index = 1; index < parts.length; index += 1) {
			const parent = parts.slice(0, index).join('/');
			if (normalized.has(parent.normalize('NFKC').toLowerCase())) {
				throw new Error(`路径冲突：${parent} 是文件，不能作为目录`);
			}
		}
	}
	return valid;
}

/** Markdown, Canvas, and ordinary attachments are eligible; local state and oversized files are not. */
export function isSyncablePath(path: string, size: number, configDir: string): boolean {
	if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) return false;
	try {
		const validPath = validateVaultPath(path);
		const key = validPath.normalize('NFKC').toLowerCase();
		const configKey = configDir.replace(/\\/g, '/').replace(/\/$/, '').normalize('NFKC').toLowerCase();
		return key !== configKey && !key.startsWith(`${configKey}/`);
	} catch {
		return false;
	}
}

export interface PendingApply {
	beforeHash: string | null;
	desiredHash: string | null;
}

export function recoverPendingApply(
	currentHash: string | null,
	pending: PendingApply,
): 'finish' | 'retry' | 'preserve-local' {
	if (currentHash === pending.desiredHash) return 'finish';
	if (currentHash === pending.beforeHash) return 'retry';
	return 'preserve-local';
}
