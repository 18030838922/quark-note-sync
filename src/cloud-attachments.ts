import { validateVaultPath } from './core.ts';

export interface CloudAttachment {
	size: number;
	sha256: string;
	headId?: string;
	deferred: boolean;
	pinned: boolean;
}

export type CloudAttachmentIndex = Record<string, CloudAttachment>;

const key = (path: string): string => path.normalize('NFKC').toLowerCase();

export function isCloudAttachment(path: string): boolean {
	return !/\.(md|markdown|canvas|base)$/i.test(path);
}

export function normalizeCloudAttachments(input: unknown): CloudAttachmentIndex {
	const result = Object.create(null) as CloudAttachmentIndex;
	if (!input || typeof input !== 'object' || Array.isArray(input)) return result;
	for (const [path, candidate] of Object.entries(input)) {
		if (!candidate || typeof candidate !== 'object' || !isCloudAttachment(path)) continue;
		try { validateVaultPath(path); } catch { continue; }
		const data = candidate as Partial<CloudAttachment>;
		if (typeof data.size !== 'number' || !Number.isSafeInteger(data.size) || data.size < 0 ||
			typeof data.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(data.sha256)) continue;
		const headId = typeof data.headId === 'string' && /^[a-f\d]{64}$/i.test(data.headId) ? data.headId.toLowerCase() : undefined;
		result[path] = { size: data.size, sha256: data.sha256.toLowerCase(), ...(headId ? { headId } : {}), deferred: data.deferred === true, pinned: data.pinned === true };
	}
	return result;
}

/** Prefer an explicit path or the note's own folder before using a unique basename. */
export function findDeferredAttachment(index: CloudAttachmentIndex, link: string, notePath: string, deferredOnly = true): string | undefined {
	const normalized = link.trim().replace(/\\/g, '/');
	if (!normalized) return undefined;
	const parts = notePath.split('/').slice(0, -1);
	for (const segment of normalized.split('/')) {
		if (segment === '.') continue;
		if (segment === '..') {
			if (!parts.length) return undefined;
			parts.pop();
		} else if (segment) parts.push(segment);
	}
	const paths = Object.keys(index);
	const exact = (candidate: string) => paths.filter((path) => key(path) === key(candidate));
	const choose = (matches: string[]) => matches.length === 1 && (!deferredOnly || index[matches[0]].deferred) ? matches[0] : undefined;
	if (normalized.includes('/')) {
		const direct = normalized.startsWith('.') ? [] : exact(normalized.replace(/^\//, ''));
		return direct.length ? choose(direct) : choose(exact(parts.join('/')));
	}
	const relative = exact(parts.join('/'));
	if (relative.length) return choose(relative);
	return choose(paths.filter((path) => key(path.slice(path.lastIndexOf('/') + 1)) === key(normalized)));
}
