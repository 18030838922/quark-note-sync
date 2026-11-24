import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeVaultFiles } from '../src/dashboard-stats.ts';

test('summarizes registered files by kind and safely ignores invalid sizes', () => {
	const result = summarizeVaultFiles([
		{ path: 'notes/one.md', extension: 'md', stat: { size: 4 } },
		{ path: 'boards/map.canvas', extension: 'canvas', stat: { size: 0 } },
		{ path: 'images/cover.PNG', extension: 'PNG', stat: { size: 12 * 1024 * 1024 } },
		{ path: 'docs/guide.pdf', extension: 'pdf', stat: { size: Number.NaN } },
		{ path: 'media/clip.mp4', extension: 'mp4', stat: { size: -1 } },
		{ path: 'misc/archive.zip', extension: 'zip', stat: { size: Number.POSITIVE_INFINITY } },
	]);

	assert.equal(result.fileCount, 6);
	assert.equal(result.totalBytes, 4 + 12 * 1024 * 1024);
	assert.deepEqual(result.byKind, [
		{ kind: 'notes', bytes: 4, count: 2 },
		{ kind: 'images', bytes: 12 * 1024 * 1024, count: 1 },
		{ kind: 'documents', bytes: 0, count: 1 },
		{ kind: 'media', bytes: 0, count: 1 },
		{ kind: 'other', bytes: 0, count: 1 },
	]);
	assert.deepEqual(result.largest, [
		{ path: 'images/cover.PNG', bytes: 12 * 1024 * 1024 },
		{ path: 'notes/one.md', bytes: 4 },
		{ path: 'boards/map.canvas', bytes: 0 },
		{ path: 'docs/guide.pdf', bytes: 0 },
		{ path: 'media/clip.mp4', bytes: 0 },
	]);
});

test('returns at most five largest files in descending size with deterministic path ties', () => {
	const result = summarizeVaultFiles([
		{ path: 'z.md', extension: 'md', stat: { size: 7 } },
		{ path: 'b.md', extension: 'md', stat: { size: 9 } },
		{ path: 'd.md', extension: 'md', stat: { size: 9 } },
		{ path: 'a.md', extension: 'md', stat: { size: 9 } },
		{ path: 'c.md', extension: 'md', stat: { size: 9 } },
		{ path: 'e.md', extension: 'md', stat: { size: 9 } },
		{ path: 'f.md', extension: 'md', stat: { size: 9 } },
	]);

	assert.deepEqual(result.largest, [
		{ path: 'a.md', bytes: 9 },
		{ path: 'b.md', bytes: 9 },
		{ path: 'c.md', bytes: 9 },
		{ path: 'd.md', bytes: 9 },
		{ path: 'e.md', bytes: 9 },
	]);
});

test('returns an empty summary when no files are registered', () => {
	assert.deepEqual(summarizeVaultFiles([]), {
		totalBytes: 0,
		fileCount: 0,
		byKind: [
			{ kind: 'notes', bytes: 0, count: 0 },
			{ kind: 'images', bytes: 0, count: 0 },
			{ kind: 'documents', bytes: 0, count: 0 },
			{ kind: 'media', bytes: 0, count: 0 },
			{ kind: 'other', bytes: 0, count: 0 },
		],
		largest: [],
	});
});
