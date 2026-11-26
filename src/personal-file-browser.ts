import type { RemoteDirectoryPage, RemoteFile } from './quark-api.ts';

export interface DirectoryCrumb {
	fid: string;
	name: string;
}

export interface PersonalDirectoryShortcuts {
	recent: DirectoryCrumb[][];
	favorites: DirectoryCrumb[][];
}

export const RECENT_DIRECTORY_LIMIT = 10;
export const FAVORITE_DIRECTORY_LIMIT = 30;

export function normalizePersonalDirectoryShortcuts(value: unknown): PersonalDirectoryShortcuts {
	const record = asRecord(value);
	return {
		recent: normalizePaths(record.recent, RECENT_DIRECTORY_LIMIT),
		favorites: normalizePaths(record.favorites, FAVORITE_DIRECTORY_LIMIT),
	};
}

function normalizePaths(value: unknown, limit: number): DirectoryCrumb[][] {
	if (!Array.isArray(value)) return [];
	const paths: DirectoryCrumb[][] = [];
	const seen = new Set<string>();
	for (const rawPath of value) {
		if (!Array.isArray(rawPath) || rawPath.length < 2 || rawPath.length > 128) continue;
		const path: DirectoryCrumb[] = [];
		const pathFids = new Set<string>();
		for (const rawCrumb of rawPath) {
			const { fid, name } = asRecord(rawCrumb);
			if (typeof fid !== 'string' || !/^[\w-]{1,128}$/.test(fid) || pathFids.has(fid)) break;
			if (typeof name !== 'string' || !name.length || name.length > 1024) break;
			pathFids.add(fid);
			path.push({ fid, name });
		}
		if (path.length !== rawPath.length || path[0].fid !== '0') continue;
		const fid = path[path.length - 1].fid;
		if (seen.has(fid)) continue;
		seen.add(fid);
		paths.push(path);
		if (paths.length === limit) break;
	}
	return paths;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export class DirectoryChangedDuringSearchError extends Error {}

interface PendingFolder {
	crumbs: DirectoryCrumb[];
	page: number;
	total?: number;
	seen: Set<string>;
}

const SEARCH_PAGES_PER_BATCH = 12;

export class PersonalFileSearch {
	readonly results: Array<{ file: RemoteFile; ancestors: DirectoryCrumb[] }> = [];
	skippedFolders = 0;
	private readonly query: string;
	private readonly pending = new Map<string, PendingFolder>();
	private readonly discoveredFolders = new Set<string>();
	private readonly matchingFids = new Set<string>();

	constructor(query: string, roots: DirectoryCrumb[]) {
		this.query = normalizeName(query.trim());
		for (const crumb of roots) this.discoveredFolders.add(crumb.fid);
		this.queueFolder(roots[roots.length - 1].fid, roots);
	}

	get hasMore(): boolean {
		return this.pending.size > 0;
	}

	get nextFolder(): DirectoryCrumb[] | undefined {
		return this.pending.values().next().value?.crumbs;
	}

	skipFolder(): void {
		const fid = this.pending.keys().next().value;
		if (fid !== undefined && this.pending.delete(fid)) this.skippedFolders += 1;
	}

	async scan(
		listPage: (fid: string, page: number) => Promise<RemoteDirectoryPage>,
		isActive: () => boolean,
		pageBudget = SEARCH_PAGES_PER_BATCH,
	): Promise<void> {
		for (let remaining = pageBudget; remaining > 0 && isActive(); remaining -= 1) {
			const first = this.pending.entries().next().value;
			if (!first) break;
			const [fid, folder] = first;
			const { entries, total } = await listPage(fid, folder.page);
			if (!isActive()) return;
			const pageFids = new Set(entries.map((entry) => entry.fid));
			if (pageFids.size !== entries.length || entries.some((entry) => folder.seen.has(entry.fid))
				|| (folder.total !== undefined && folder.total !== total)
				|| folder.seen.size + entries.length > total
				|| (!entries.length && folder.seen.size !== total)) {
				throw new DirectoryChangedDuringSearchError('Directory changed during search.');
			}
			folder.total = total;
			for (const entry of entries) {
				folder.seen.add(entry.fid);
				if (entry.isDirectory) {
					if (!this.discoveredFolders.has(entry.fid)) {
						this.queueFolder(entry.fid, [...folder.crumbs, { fid: entry.fid, name: entry.name }]);
					}
				} else if (!this.matchingFids.has(entry.fid) && normalizeName(entry.name).includes(this.query)) {
					this.matchingFids.add(entry.fid);
					this.results.push({ file: entry, ancestors: folder.crumbs });
				}
			}
			if (folder.seen.size === total) this.pending.delete(fid);
			else folder.page += 1;
		}
	}

	private queueFolder(fid: string, crumbs: DirectoryCrumb[]): void {
		this.discoveredFolders.add(fid);
		this.pending.set(fid, { crumbs, page: 1, seen: new Set() });
	}
}

function normalizeName(value: string): string {
	return value.normalize('NFC').toLowerCase();
}
