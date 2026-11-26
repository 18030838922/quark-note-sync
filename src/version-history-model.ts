import { IncompleteHistoryError, resolvePathEvents, validateVaultPath, type VersionEvent } from './core.ts';
import { sha256Hex } from './hash.ts';

const MAX_PREVIEW_BYTES = 128 * 1024;
const MAX_DIFF_LINES = 1000;
const MAX_DIFF_CELLS = 250_000;
const MAX_COPY_ATTEMPTS = 1000;
const MAX_FILENAME_BYTES = 255;
const TEXT_EXTENSION = /\.(md|markdown|canvas|txt|json|csv|tsv|yaml|yml|xml|html|css|js|ts|log|svg)$/i;

export interface DeletedHistoryPath {
	path: string;
	deletedAt: number;
}

export type VersionRestoreMode = 'copy' | 'current';

export interface VersionRestoreTarget {
	isPathOccupied(path: string): Promise<boolean>;
	write(path: string, bytes: Uint8Array, expectedCurrentHash: string | null): Promise<void>;
}

export interface VersionDiffLine {
	kind: 'same' | 'delete' | 'add';
	text: string;
}

export function listFileVersions(events: readonly VersionEvent[], path: string): VersionEvent[] {
	validateVaultPath(path);
	const history = events.filter((event) => event.path === path);
	if (history.length > 0) resolvePathEvents(history);
	return history.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

export function listRecoverableDeletedPaths(events: readonly VersionEvent[]): DeletedHistoryPath[] {
	const paths = new Map<string, VersionEvent[]>();
	for (const event of events) {
		const history = paths.get(event.path);
		if (history) history.push(event);
		else paths.set(event.path, [event]);
	}
	const deleted: DeletedHistoryPath[] = [];
	for (const [path, history] of paths) {
		if (!history.some((event) => event.kind === 'file') || !history.some((event) => event.kind === 'delete')) continue;
		try {
			const state = resolvePathEvents(history);
			if (state.deleted) {
				const deletedAt = state.heads.reduce((latest, head) => Math.max(latest, head.createdAt), 0);
				deleted.push({ path, deletedAt });
			}
		} catch (error) {
			if (!(error instanceof IncompleteHistoryError)) throw error;
		}
	}
	return deleted.sort((a, b) => b.deletedAt - a.deletedAt || a.path.localeCompare(b.path));
}

export async function restoreVersionLocally(
	event: VersionEvent,
	bytes: Uint8Array,
	mode: VersionRestoreMode,
	expectedCurrentHash: string | null,
	local: VersionRestoreTarget,
): Promise<string> {
	validateVaultPath(event.path);
	if (event.kind !== 'file') throw new Error('删除记录没有可恢复的文件内容');
	if (bytes.byteLength !== event.size || await sha256Hex(bytes) !== event.sha256) {
		throw new Error('历史版本内容校验失败');
	}
	if (mode === 'current') {
		await local.write(event.path, bytes, expectedCurrentHash);
		return event.path;
	}
	for (let attempt = 1; attempt <= MAX_COPY_ATTEMPTS; attempt += 1) {
		const path = versionCopyPath(event, attempt);
		if (await local.isPathOccupied(path)) continue;
		await local.write(path, bytes, null);
		return path;
	}
	throw new Error('无法找到可用的恢复副本文件名');
}

export function canPreviewVersionText(path: string, size: number): boolean {
	return size >= 0 && size <= MAX_PREVIEW_BYTES && TEXT_EXTENSION.test(path);
}

export function decodeVersionText(path: string, bytes: Uint8Array): string | null {
	if (!canPreviewVersionText(path, bytes.byteLength)) return null;
	try {
		const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
		return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text) ? null : text;
	} catch {
		return null;
	}
}

/** A bounded line comparison from local content to the selected cloud version. */
export function buildVersionDiff(current: string, historical: string): VersionDiffLine[] | null {
	if (current.length > MAX_PREVIEW_BYTES || historical.length > MAX_PREVIEW_BYTES) return null;
	const toLines = (text: string) => text.replace(/\r\n?/g, '\n').match(/[^\n]*\n|[^\n]+$/g) ?? [];
	const before = toLines(current);
	const after = toLines(historical);
	if (before.length > MAX_DIFF_LINES || after.length > MAX_DIFF_LINES) return null;

	let prefix = 0;
	while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
	let beforeEnd = before.length;
	let afterEnd = after.length;
	while (beforeEnd > prefix && afterEnd > prefix && before[beforeEnd - 1] === after[afterEnd - 1]) {
		beforeEnd -= 1;
		afterEnd -= 1;
	}

	const beforeCount = beforeEnd - prefix;
	const afterCount = afterEnd - prefix;
	const width = afterCount + 1;
	const cells = (beforeCount + 1) * width;
	if (cells > MAX_DIFF_CELLS) return null;
	const lcs = new Uint16Array(cells);
	for (let row = beforeCount - 1; row >= 0; row -= 1) {
		for (let col = afterCount - 1; col >= 0; col -= 1) {
			const index = row * width + col;
			lcs[index] = before[prefix + row] === after[prefix + col]
				? 1 + lcs[index + width + 1]
				: Math.max(lcs[index + width], lcs[index + 1]);
		}
	}
	const lines: VersionDiffLine[] = [];
	const addLine = (kind: VersionDiffLine['kind'], line: string) => {
		lines.push({ kind, text: line.endsWith('\n') ? line.slice(0, -1) : line });
	};
	for (const line of before.slice(0, prefix)) addLine('same', line);
	let row = 0;
	let col = 0;
	while (row < beforeCount || col < afterCount) {
		const index = row * width + col;
		if (row < beforeCount && col < afterCount && before[prefix + row] === after[prefix + col]) {
			addLine('same', before[prefix + row++]);
			col += 1;
		} else if (row < beforeCount && (col === afterCount || lcs[index + width] >= lcs[index + 1])) {
			addLine('delete', before[prefix + row++]);
		} else {
			addLine('add', after[prefix + col++]);
		}
	}
	for (const line of before.slice(beforeEnd)) addLine('same', line);
	return lines;
}

function versionCopyPath(event: VersionEvent, attempt: number): string {
	const slash = event.path.lastIndexOf('/') + 1;
	const directory = event.path.slice(0, slash);
	const filename = event.path.slice(slash);
	const dot = filename.lastIndexOf('.');
	const encoder = new TextEncoder();
	const extension = dot > 0 && encoder.encode(filename.slice(dot)).length <= 32 ? filename.slice(dot) : '';
	const basename = extension ? filename.slice(0, dot) : filename;
	const tag = event.id.slice(0, 12);
	const sequence = attempt === 1 ? '' : ' ' + attempt;
	const suffix = ' (restored ' + tag + sequence + ')' + extension;
	const available = MAX_FILENAME_BYTES - encoder.encode(suffix).length;
	let stem = '';
	let used = 0;
	for (const character of basename) {
		used += encoder.encode(character).length;
		if (used > available) break;
		stem += character;
	}
	return validateVaultPath(directory + stem + suffix);
}
