import { sha256Hex } from './hash.ts';

export const MAX_IMAGE_PREVIEW_BYTES = 20 * 1024 * 1024;
export const MAX_DOCUMENT_PREVIEW_BYTES = 20 * 1024 * 1024;
export const MAX_MEDIA_PREVIEW_BYTES = 50 * 1024 * 1024;
export const MAX_PERSONAL_DOWNLOAD_BYTES = 100 * 1024 * 1024;

export interface PersonalReference {
	accountKey: string;
	fid: string;
}

export interface PersonalReferenceLinkRange {
	from: number;
	to: number;
	label: string;
	embedded: boolean;
	reference: PersonalReference;
}

export interface OfficialShareReference {
	pwdId: string;
	passcode: string;
	officialUrl: string;
	selectedParentFid?: string;
	selectedFid?: string;
}

export interface OfficialShareLinkRange {
	from: number;
	to: number;
	label: string;
	embedded: boolean;
	rawUrl: string;
	reference: OfficialShareReference;
}

export type PreviewKind = 'image' | 'document' | 'audio' | 'video' | 'unsupported';

const SAFE_ID = /^[\w-]{1,128}$/;
const ACCOUNT_KEY = /^[a-f\d]{64}$/i;

export async function accountReferenceKey(accountId: string): Promise<string> {
	if (!SAFE_ID.test(accountId)) throw new Error('夸克账号编号无效');
	return await sha256Hex(new TextEncoder().encode(`quark-account-reference:${accountId}`));
}

export function formatPersonalReference(name: string, accountKey: string, fid: string): string {
	if (!ACCOUNT_KEY.test(accountKey) || !SAFE_ID.test(fid)) throw new Error('夸克引用账号或文件编号无效');
	const label = escapeMarkdownLabel(name);
	return `[${label}](obsidian://quark-note?account=${encodeURIComponent(accountKey.toLowerCase())}&fid=${encodeURIComponent(fid)})`;
}

export function formatPublicShareReference(name: string, pwdId: string, fid: string, parentFid: string): string {
	if (!/^[\w-]{4,128}$/.test(pwdId) || !SAFE_ID.test(fid) || !SAFE_ID.test(parentFid)) {
		throw new Error('夸克分享或文件编号无效');
	}
	const url = `https://pan.quark.cn/s/${pwdId}#/list/share/${encodeURIComponent(parentFid)}?fid=${encodeURIComponent(fid)}`;
	return `[${escapeMarkdownLabel(name)}](${url})`;
}

export function parsePersonalReference(input: string): PersonalReference | null {
	try {
		const url = new URL(input);
		if (url.protocol !== 'obsidian:' || url.hostname !== 'quark-note' || url.username || url.password || url.port || url.hash ||
			!['', '/'].includes(url.pathname)) return null;
		const keys = [...url.searchParams.keys()];
		if (keys.length !== 2 || keys.filter((key) => key === 'account').length !== 1 ||
			keys.filter((key) => key === 'fid').length !== 1) return null;
		const accountId = url.searchParams.get('account') ?? '';
		const fid = url.searchParams.get('fid') ?? '';
		if (!ACCOUNT_KEY.test(accountId) || !SAFE_ID.test(fid)) return null;
		return { accountKey: accountId.toLowerCase(), fid };
	} catch {
		return null;
	}
}

export function findPersonalReferenceLinks(markdown: string): PersonalReferenceLinkRange[] {
	const matches: PersonalReferenceLinkRange[] = [];
	const pattern = /(!?)\[((?:\\.|[^\\\]\r\n])*)\]\((obsidian:\/\/quark-note\?[^\s)]+)\)/gi;
	for (const match of markdown.matchAll(pattern)) {
		const whole = match[0];
		const start = match.index;
		if (start === undefined) continue;
		const reference = parsePersonalReference(match[3]);
		if (!reference) continue;
		matches.push({
			from: start,
			to: start + whole.length,
			label: (match[2] ?? '').replace(/\\([\\\[\]])/g, '$1'),
			embedded: match[1] === '!',
			reference,
		});
	}
	return matches;
}

export function parseOfficialShareUrl(input: string): OfficialShareReference | null {
	try {
		const url = new URL(input.trim());
		if (url.protocol !== 'https:' || url.hostname !== 'pan.quark.cn' || url.username || url.password || url.port) return null;
		const segments = url.pathname.split('/').filter(Boolean);
		if (segments.length !== 2 || segments[0] !== 's' || !/^[\w-]{4,128}$/.test(segments[1])) return null;
		const route = url.hash ? /^#\/list\/share(?:\/([\w-]{1,128}))?(?:\?fid=([\w-]{1,128}))?\/?$/i.exec(url.hash) : null;
		if (url.hash && !route) return null;
		const pwdId = segments[1];
		const pwdValues = [...url.searchParams.getAll('pwd'), ...url.searchParams.getAll('passcode')];
		if (pwdValues.length > 1) return null;
		const passcode = pwdValues[0] ?? '';
		if (passcode.length > 64 || /[\r\n\u0000-\u001f]/.test(passcode)) return null;
		const officialUrl = new URL(url.toString());
		officialUrl.search = '';
		return {
			pwdId,
			passcode,
			officialUrl: officialUrl.toString(),
			...(route?.[1] ? { selectedParentFid: route[1] } : {}),
			...(route?.[2] ? { selectedFid: route[2] } : {}),
		};
	} catch {
		return null;
	}
}

export function findOfficialShareUrl(input: string): string | null {
	const candidates = input.match(/https:\/\/pan\.quark\.cn\/s\/[\w-]+(?:\?[^\s<>()]*)?(?:#\/list\/share(?:\/[\w-]+)?(?:\?fid=[\w-]+)?)?/gi) ?? [];
	for (const candidate of candidates) {
		const trimmed = candidate.replace(/[\],.;!?]+$/g, '');
		if (parseOfficialShareUrl(trimmed)) return trimmed;
	}
	return null;
}

export function findOfficialShareLinks(markdown: string): OfficialShareLinkRange[] {
	const matches: OfficialShareLinkRange[] = [];
	const pattern = /(!?)\[((?:\\.|[^\\\]\r\n])*)\]\((https:\/\/pan\.quark\.cn\/s\/[\w-]+(?:\?[^\s)]*)?(?:#\/list\/share(?:\/[\w-]+)?(?:\?fid=[\w-]+)?)?)\)/gi;
	for (const match of markdown.matchAll(pattern)) {
		const start = match.index;
		if (start === undefined) continue;
		const reference = parseOfficialShareUrl(match[3]);
		if (!reference) continue;
		matches.push({
			from: start,
			to: start + match[0].length,
			label: (match[2] ?? '').replace(/\\([\\\[\]])/g, '$1'),
			embedded: match[1] === '!',
			rawUrl: match[3],
			reference,
		});
	}
	return matches;
}

function escapeMarkdownLabel(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/([\[\]])/g, '\\$1').replace(/[\r\n]+/g, ' ');
}

export function previewKindForFile(name: string): { kind: PreviewKind; maxBytes: number } {
	const extension = name.split('/').pop()?.split('.').pop()?.toLowerCase() ?? '';
	if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(extension)) {
		return { kind: 'image', maxBytes: MAX_IMAGE_PREVIEW_BYTES };
	}
	if (['pdf', 'txt', 'md', 'markdown', 'csv', 'json', 'log', 'xml'].includes(extension)) {
		return { kind: 'document', maxBytes: MAX_DOCUMENT_PREVIEW_BYTES };
	}
	if (['mp3', 'm4a', 'aac', 'wav', 'ogg', 'flac', 'opus'].includes(extension)) {
		return { kind: 'audio', maxBytes: MAX_MEDIA_PREVIEW_BYTES };
	}
	if (['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi'].includes(extension)) {
		return { kind: 'video', maxBytes: MAX_MEDIA_PREVIEW_BYTES };
	}
	return { kind: 'unsupported', maxBytes: 0 };
}

export function mimeTypeForFile(name: string): string {
	const extension = name.split('/').pop()?.split('.').pop()?.toLowerCase() ?? '';
	const mimeTypes: Record<string, string> = {
		png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
		pdf: 'application/pdf', txt: 'text/plain', md: 'text/plain', markdown: 'text/plain', csv: 'text/plain', json: 'text/plain', log: 'text/plain', xml: 'text/plain',
		mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', opus: 'audio/ogg',
		mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
	};
	return mimeTypes[extension] ?? 'application/octet-stream';
}


export function isInlineMediaName(name: string): boolean {
	const { kind } = previewKindForFile(name.trim());
	return kind === 'image' || kind === 'audio' || kind === 'video';
}

/** Map a selection through one contiguous change, retaining edits outside it. */
export function mapInsertionRange(before: string, after: string, from: number, to: number): [number, number] | null {
	if (before === after) return [from, to];
	let start = 0;
	while (start < before.length && start < after.length && before[start] === after[start]) start++;
	let end = before.length;
	let newEnd = after.length;
	while (end > start && newEnd > start && before[end - 1] === after[newEnd - 1]) {
		end--;
		newEnd--;
	}
	if (end <= from) return [from + newEnd - end, to + newEnd - end];
	if (start >= to) return [from, to];
	return null;
}

export function loadWhenVisible(element: HTMLElement, load: () => void): () => void {
	const Observer = element.ownerDocument.defaultView?.IntersectionObserver;
	if (!Observer) return () => {};
	const observer = new Observer((entries) => {
		if (entries.some((entry) => entry.isIntersecting)) {
			observer.disconnect();
			if (element.isConnected) load();
		}
	});
	observer.observe(element);
	return () => observer.disconnect();
}
