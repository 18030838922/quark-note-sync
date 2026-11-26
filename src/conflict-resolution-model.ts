import type { VersionEvent } from './core.ts';
import { buildVersionDiff } from './version-history-model.ts';

export interface SyncConflict {
	path: string;
	cloudVersions: VersionEvent[];
}

export interface ConflictPreview {
	path: string;
	headIds: string[];
	localHash: string | null;
	localBytes: Uint8Array | null;
	localSize?: number;
	cloudVersion: VersionEvent;
	cloudBytes: Uint8Array | null;
	baseBytes: Uint8Array | null;
}

export type ConflictResolutionChoice = { kind: 'local' } | { kind: 'cloud' }
	| { kind: 'merged'; bytes: Uint8Array };

export interface ConflictResolutionRequest {
	path: string;
	expectedHeadIds: string[];
	expectedLocalHash: string | null;
	cloudVersionId: string;
	choice: ConflictResolutionChoice;
}

export type MergeSide = 'local' | 'cloud';
export type MergeSection = { kind: 'fixed'; text: string } | { kind: 'choice'; local: string; cloud: string };

interface LineEdit {
	side: MergeSide;
	start: number;
	end: number;
	replacement: string[];
}

/** A merge base must be a single nearest shared file event in the validated path history. */
export function findConflictBase(
	history: readonly VersionEvent[],
	localVersionId: string,
	cloudVersionId: string,
): VersionEvent | null {
	const events = new Map(history.map((event) => [event.id, event]));
	const local = events.get(localVersionId);
	const cloud = events.get(cloudVersionId);
	if (!local || !cloud || local.path !== cloud.path) return null;
	const cloudAncestors = ancestors(cloud.id, events);
	const shared = [...ancestors(local.id, events)].filter((id) => cloudAncestors.has(id));
	const older = new Set(shared.flatMap((id) => events.get(id)?.parents ?? []));
	const nearest = shared.filter((id) => !older.has(id));
	const base = nearest.length === 1 ? events.get(nearest[0]) : undefined;
	return base?.kind === 'file' ? base : null;
}

function ancestors(id: string, events: ReadonlyMap<string, VersionEvent>): Set<string> {
	const pending = [id];
	const visited = new Set<string>();
	while (pending.length > 0) {
		const next = pending.pop()!;
		const event = events.get(next);
		if (!event || visited.has(next)) continue;
		visited.add(next);
		for (const parent of event.parents) pending.push(parent);
	}
	return visited;
}

/** Uses the bounded history diff for alignment and retains each source line's exact ending. */
export function buildConflictMerge(local: string, cloud: string, base: string | null): MergeSection[] | null {
	const source = base ?? local;
	const sourceLines = rawLines(source);
	const localEdits = base === null ? [] : lineEdits(source, sourceLines, local, 'local');
	const cloudEdits = lineEdits(source, sourceLines, cloud, 'cloud');
	if (!localEdits || !cloudEdits) return null;
	const edits = [...localEdits, ...cloudEdits].sort((a, b) => a.start - b.start || a.end - b.end);
	const sections: MergeSection[] = [];
	let cursor = 0;
	let index = 0;
	const addFixed = (text: string) => {
		if (text.length > 0) sections.push({ kind: 'fixed', text });
	};
	while (index < edits.length) {
		const first = edits[index];
		addFixed(sourceLines.slice(cursor, first.start).join(''));
		const group = [first];
		let end = first.end;
		let unterminatedEnd = hasUnterminatedLastLine(first) ? first.end : -1;
		index += 1;
		while (index < edits.length) {
			const next = edits[index];
			const overlaps = next.start < end || next.start === first.start;
			// Appending after another edit that removes the final line break would join two lines.
			const appendsToUnterminatedLine = next.start === end && next.end === end && unterminatedEnd === end;
			if (!overlaps && !appendsToUnterminatedLine) break;
			group.push(next);
			end = Math.max(end, next.end);
			if (hasUnterminatedLastLine(next)) unterminatedEnd = Math.max(unterminatedEnd, next.end);
			index += 1;
		}
		const original = sourceLines.slice(first.start, end).join('');
		const localText = applyLineEdits(sourceLines, first.start, end, group.filter((edit) => edit.side === 'local'));
		const cloudText = applyLineEdits(sourceLines, first.start, end, group.filter((edit) => edit.side === 'cloud'));
		if (localText === cloudText || (base !== null && cloudText === original)) addFixed(localText);
		else if (base !== null && localText === original) addFixed(cloudText);
		else sections.push({ kind: 'choice', local: localText, cloud: cloudText });
		cursor = end;
	}
	addFixed(sourceLines.slice(cursor).join(''));
	return sections;
}

export function composeConflictMerge(
	sections: readonly MergeSection[],
	choices: readonly (MergeSide | undefined)[],
): string | null {
	const output: string[] = [];
	let index = 0;
	for (const section of sections) {
		if (section.kind === 'fixed') {
			output.push(section.text);
			continue;
		}
		const side = choices[index++];
		if (side === undefined) return null;
		output.push(section[side]);
	}
	return output.join('');
}

function rawLines(text: string): string[] {
	return text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
}

function lineEdits(source: string, sourceLines: string[], target: string, side: MergeSide): LineEdit[] | null {
	const rows = buildVersionDiff(source, target);
	if (!rows) return null;
	const targetLines = rawLines(target);
	const edits: LineEdit[] = [];
	let before = 0;
	let after = 0;
	let current: LineEdit | undefined;
	for (const row of rows) {
		if (row.kind === 'same' && sourceLines[before] === targetLines[after]) {
			current = undefined;
		} else {
			if (!current) {
				current = { side, start: before, end: before, replacement: [] };
				edits.push(current);
			}
			if (row.kind !== 'add') current.end += 1;
			if (row.kind !== 'delete') current.replacement.push(targetLines[after]);
		}
		if (row.kind !== 'add') before += 1;
		if (row.kind !== 'delete') after += 1;
	}
	return edits;
}

function applyLineEdits(source: string[], start: number, end: number, edits: LineEdit[]): string {
	const output: string[] = [];
	let cursor = start;
	for (const edit of edits) {
		output.push(...source.slice(cursor, edit.start), ...edit.replacement);
		cursor = edit.end;
	}
	output.push(...source.slice(cursor, end));
	return output.join('');
}

function hasUnterminatedLastLine(edit: LineEdit): boolean {
	const last = edit.replacement[edit.replacement.length - 1];
	return last !== undefined && !/[\r\n]$/.test(last);
}
