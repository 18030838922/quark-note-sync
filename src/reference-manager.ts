import { sha256Hex } from './hash.ts';
import { findOfficialShareLinks, findPersonalReferenceLinks, mapInsertionRange, parseOfficialShareUrl, parsePersonalReference } from './quark-references.ts';
import type { OfficialShareReference, PersonalReference } from './quark-references.ts';
import { sourceIndexKey, type SourceIndex, type SourceIndexEntry } from './source-index.ts';

export type QuarkReferenceTarget =
	| { kind: 'personal'; reference: PersonalReference }
	| { kind: 'share'; reference: OfficialShareReference };

export type ReferenceStatus = 'available' | 'broken' | 'unknown';

interface ReferenceOccurrence {
	from: number;
	to: number;
	label: string;
	destination?: { from: number; to: number };
	target: QuarkReferenceTarget;
}

export interface QuarkReferenceRow extends ReferenceOccurrence {
	notePath: string;
	line: number;
	targetKey: string;
	localCopies: readonly SourceIndexEntry[];
	noteMarkdown: string;
}

export async function publicShareReferenceKey(pwdId: string): Promise<string> {
	return await sha256Hex(new TextEncoder().encode(`quark-public-share-reference:${pwdId}`));
}

export function indexLocalCopies(
	index: SourceIndex,
	vaultFileSize: (path: string) => number | undefined,
): Map<string, SourceIndexEntry[]> {
	const copiesBySource = new Map<string, SourceIndexEntry[]>();
	for (const entry of Object.values(index)) {
		if (vaultFileSize(entry.localPath) !== entry.size) continue;
		const key = sourceIndexKey(entry.accountKey, entry.fid);
		const copies = copiesBySource.get(key);
		if (copies) copies.push(entry);
		else copiesBySource.set(key, [entry]);
	}
	for (const copies of copiesBySource.values()) copies.sort((a, b) => b.downloadedAt - a.downloadedAt);
	return copiesBySource;
}

export async function collectNoteReferences(
	notePath: string,
	noteMarkdown: string,
	localCopies: ReadonlyMap<string, readonly SourceIndexEntry[]>,
): Promise<QuarkReferenceRow[]> {
	const rows: QuarkReferenceRow[] = [];
	let line = 1;
	let nextLine = noteMarkdown.indexOf('\n');
	for (const occurrence of findNoteReferences(noteMarkdown)) {
		while (nextLine !== -1 && nextLine < occurrence.from) {
			line += 1;
			nextLine = noteMarkdown.indexOf('\n', nextLine + 1);
		}
		const { target } = occurrence;
		let targetKey: string;
		let localKey: string | undefined;
		if (target.kind === 'personal') {
			localKey = sourceIndexKey(target.reference.accountKey, target.reference.fid);
			targetKey = `personal:${localKey}`;
		} else {
			const { pwdId, passcode, selectedParentFid, selectedFid } = target.reference;
			targetKey = JSON.stringify(['share', pwdId, passcode, selectedParentFid, selectedFid]);
			if (selectedFid && localCopies.size) localKey = sourceIndexKey(await publicShareReferenceKey(pwdId), selectedFid);
		}
		rows.push({ ...occurrence, notePath, noteMarkdown, line, targetKey, localCopies: localKey ? localCopies.get(localKey) ?? [] : [] });
	}
	return rows;
}

export async function verifyReferences(
	rows: readonly QuarkReferenceRow[],
	check: (target: QuarkReferenceTarget, signal: AbortSignal) => Promise<ReferenceStatus>,
	signal: AbortSignal,
): Promise<Map<string, ReferenceStatus>> {
	const statuses = new Map<string, ReferenceStatus>();
	for (const { targetKey, target } of rows) {
		if (signal.aborted) break;
		if (statuses.has(targetKey)) continue;
		try {
			statuses.set(targetKey, await check(target, signal));
		} catch {
			statuses.set(targetKey, 'unknown');
		}
	}
	return statuses;
}

export function getReferenceReplacement(
	row: QuarkReferenceRow,
	currentText: string,
	selectedMarkdown: string,
): { from: number; to: number; markdown: string } | null {
	const [selection] = findNoteReferences(selectedMarkdown);
	if (!selection?.destination || selection.from !== 0 || selection.to !== selectedMarkdown.length) return null;
	const range = mapInsertionRange(row.noteMarkdown, currentText, row.from, row.to);
	if (!range) return null;
	const [from, to] = range;
	const original = row.noteMarkdown.slice(row.from, row.to);
	if (currentText.slice(from, to) !== original) return null;
	const currentLinks = findNoteReferences(currentText);
	const current = currentLinks.find((link) => link.from === from && link.to === to);
	if (!current) return null;
	if (currentText !== row.noteMarkdown &&
		currentLinks.filter((link) => currentText.slice(link.from, link.to) === original).length !==
		findNoteReferences(row.noteMarkdown).filter((link) => row.noteMarkdown.slice(link.from, link.to) === original).length) return null;
	if (!current.destination) return { from, to, markdown: selectedMarkdown };
	return { ...current.destination, markdown: selectedMarkdown.slice(selection.destination.from, selection.destination.to) };
}

function findNoteReferences(markdown: string): ReferenceOccurrence[] {
	if (!/obsidian:\/\/quark-note\?|https:\/\/pan\.quark\.cn\/s\//i.test(markdown)) return [];
	const visible = maskMarkdownExamples(markdown);
	const occurrences: ReferenceOccurrence[] = [
		...findPersonalReferenceLinks(markdown).map(({ from, to, label, reference }) => ({
			from, to, label, target: { kind: 'personal' as const, reference },
		})),
		...findOfficialShareLinks(markdown).map(({ from, to, label, reference }) => ({
			from, to, label, target: { kind: 'share' as const, reference },
		})),
	].filter(({ from, to }) => visible[from] === markdown[from] && visible[to - 1] === ')' && !isEscaped(markdown, from))
		.map((link) => ({
			...link, destination: { from: link.from + markdown.slice(link.from, link.to).lastIndexOf('](') + 2, to: link.to - 1 },
		}))
		.sort((a, b) => a.from - b.from);
	const pasted: ReferenceOccurrence[] = [];
	let index = 0;
	for (const match of visible.matchAll(/\b(?:https:\/\/pan\.quark\.cn\/s\/|obsidian:\/\/quark-note\?)[^\s<>()]+/gi)) {
		const from = match.index;
		while (occurrences[index] && occurrences[index].to <= from) index += 1;
		if (occurrences[index] && occurrences[index].from <= from) continue;
		const angled = visible[from - 1] === '<' && visible[from + match[0].length] === '>';
		const url = angled ? match[0] : match[0].replace(/[\],.;!?]+$/g, '');
		const share = parseOfficialShareUrl(url);
		const personal = share ? null : parsePersonalReference(url);
		const target: QuarkReferenceTarget | undefined = share ? { kind: 'share', reference: share }
			: personal ? { kind: 'personal', reference: personal } : undefined;
		if (!target || visible.slice(from + url.length, from + url.length + 2) === '](') continue;
		const start = angled ? from - 1 : from;
		const end = from + url.length + (angled ? 1 : 0);
		const lineStart = visible.lastIndexOf('\n', start - 1) + 1;
		const opening = /(!?\[(?:\\.|[^\\\]\r\n])*\])\([ \t]*$/.exec(markdown.slice(lineStart, start));
		if (opening) {
			const linkFrom = lineStart + opening.index;
			const closing = /^(?:[ \t]+(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^()\r\n]*\)))?[ \t]*\)/.exec(visible.slice(end));
			const parseLink = target.kind === 'personal' ? findPersonalReferenceLinks : findOfficialShareLinks;
			const [link] = parseLink(`${opening[1]}(${url})`);
			if (closing && link && visible[linkFrom] === markdown[linkFrom] && !isEscaped(markdown, linkFrom)) {
				pasted.push({ from: linkFrom, to: end + closing[0].length, label: link.label, target,
					destination: { from, to: from + url.length } });
			}
		} else if (target.kind === 'share' || angled) {
			pasted.push({ from: start, to: end, label: '', target });
		}
	}
	return [...occurrences, ...pasted].sort((a, b) => a.from - b.from);
}

function isEscaped(text: string, offset: number): boolean {
	let previous = offset - 1;
	while (previous >= 0 && text[previous] === '\\') previous -= 1;
	return (offset - previous - 1) % 2 === 1;
}

function maskMarkdownExamples(markdown: string): string {
	const mask = (value: string) => value.replace(/[^\r\n]/g, ' ');
	const body = markdown.replace(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?^(?:---|\.\.\.)[ \t]*(?=\r?$)/m, (match, offset: number) =>
		offset === 0 ? mask(match) : match);
	let fence: string | undefined;
	const withoutFences = body.split('\n').map((line) => {
		const delimiter = /^(?: {0,3}>[ \t]?)* {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (fence) {
			if (delimiter && delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && !delimiter[2].trim()) {
				fence = undefined;
			}
			return mask(line);
		}
		if (delimiter && (delimiter[1][0] === '~' || !delimiter[2].includes('`'))) {
			fence = delimiter[1];
			return mask(line);
		}
		return line;
	}).join('\n');
	return withoutFences.replace(/%%[\s\S]*?(?:%%|$)|<!--[\s\S]*?(?:-->|$)|(^|[^\\`])(`+)(?!`)[\s\S]*?[^`]\2(?!`)/g,
		(match, prefix?: string) => prefix ? prefix + mask(match.slice(prefix.length)) : mask(match));
}
