import { hasAsciiControl, type VersionEvent } from './core.ts';

export interface SyncScope {
	folders: string[];
	extensions: string[];
	maxBytes: number | null;
}

export interface ScopeSelection {
	included: string[];
	excluded: string[];
}

const key = (value: string): string => value.normalize('NFKC').toLowerCase();

export function normalizeSyncScope(input: unknown): SyncScope {
	const value = input && typeof input === 'object' ? input as Partial<SyncScope> : {};
	const folders = (Array.isArray(value.folders) ? value.folders : [])
		.filter((folder): folder is string => typeof folder === 'string')
		.map((folder) => key(folder.trim().replace(/\\/g, '/').replace(/\/+$/, '')))
		.filter((folder) => !hasAsciiControl(folder) && !/[<>:"|?*]/.test(folder) && folder.split('/').every((segment) => segment && segment !== '.' && segment !== '..'));
	const extensions = (Array.isArray(value.extensions) ? value.extensions : [])
		.filter((extension): extension is string => typeof extension === 'string')
		.map((extension) => key(extension.trim().replace(/^\./, '')))
		.filter((extension) => /^[\p{L}\p{N}_-]+$/u.test(extension));
	const maxBytes = value.maxBytes;
	return {
		folders: [...new Set(folders)],
		extensions: [...new Set(extensions)],
		maxBytes: typeof maxBytes === 'number' && Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : null,
	};
}

export function matchesSyncPath(scope: SyncScope, path: string): boolean {
	const normalizedPath = key(path);
	if (scope.folders.length && !scope.folders.some((folder) => normalizedPath.startsWith(folder + '/'))) return false;
	const filename = normalizedPath.slice(normalizedPath.lastIndexOf('/') + 1);
	const dot = filename.lastIndexOf('.');
	return !scope.extensions.length || (dot > 0 && scope.extensions.includes(filename.slice(dot + 1)));
}

/** Size applies to the local file and every current cloud head, including potential conflict copies. */
export function selectSyncScope(scope: SyncScope, local: readonly { path: string; size: number }[], events: readonly VersionEvent[], savedPaths: readonly string[] = []): ScopeSelection {
	const paths = new Set([...savedPaths, ...local.map((file) => file.path), ...events.map((event) => event.path)]);
	const outsideSize = new Set<string>();
	if (scope.maxBytes !== null) {
		const maxBytes = scope.maxBytes;
		const parents = new Set(events.flatMap((event) => event.parents));
		for (const file of local) if (file.size > maxBytes) outsideSize.add(key(file.path));
		for (const event of events) {
			if (event.kind === 'file' && !parents.has(event.id) && (event.size ?? 0) > maxBytes) outsideSize.add(key(event.path));
		}
	}
	const selection: ScopeSelection = { included: [], excluded: [] };
	for (const path of paths) {
		const allowed = matchesSyncPath(scope, path) && !outsideSize.has(key(path));
		selection[allowed ? 'included' : 'excluded'].push(path);
	}
	return selection;
}
