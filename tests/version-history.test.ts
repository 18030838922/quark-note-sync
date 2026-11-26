import assert from 'node:assert/strict';
import test from 'node:test';
import type { VersionEvent } from '../src/core.ts';
import { sha256Hex } from '../src/hash.ts';
import {
	buildVersionDiff,
	decodeVersionText,
	listFileVersions,
	listRecoverableDeletedPaths,
	restoreVersionLocally,
} from '../src/version-history-model.ts';

function file(path: string, id: string, parents: string[] = [], createdAt = 10): VersionEvent {
	return { path, id, parents, createdAt, kind: 'file', deviceId: 'pc', sha256: 'hash', size: 3 };
}

function deletion(path: string, id: string, parents: string[], createdAt = 20): VersionEvent {
	return { path, id, parents, createdAt, kind: 'delete', deviceId: 'phone' };
}

test('file history shows changes and deletions in descending time order for the requested path', () => {
	const path = 'notes/plan.md';
	const base = file(path, 'base');
	const deleted = deletion(path, 'deleted', ['base']);
	const restored = file(path, 'restored', ['deleted'], 30);
	assert.deepEqual(listFileVersions([base, file('other.md', 'other'), restored, deleted], path), [restored, deleted, base]);
	assert.deepEqual(listFileVersions([base], 'notes/missing.md'), []);
	assert.throws(() => listFileVersions([restored], path), /历史不完整/);
});

test('deleted discovery requires historical content and a resolved deletion without a live concurrent branch', () => {
	const deletedPath = 'notes/obsolete.md';
	const livePath = 'notes/active.md';
	const olderPath = 'notes/older.md';
	const events = [
		file(deletedPath, 'base-a'),
		deletion(deletedPath, 'delete-a1', ['base-a'], 30),
		deletion(deletedPath, 'delete-a2', ['base-a'], 25),
		file(livePath, 'base-b'),
		deletion(livePath, 'delete-b', ['base-b']),
		file(livePath, 'edit-b', ['base-b'], 15),
		file(olderPath, 'base-c'),
		deletion(olderPath, 'delete-c', ['base-c']),
		deletion('unknown.md', 'delete-d', []),
		file('incomplete.md', 'edit-e', ['missing']),
		deletion('incomplete.md', 'delete-e', ['edit-e']),
	];
	assert.deepEqual(listRecoverableDeletedPaths(events), [
		{ path: deletedPath, deletedAt: 30 },
		{ path: olderPath, deletedAt: 20 },
	]);
});

test('current restore uses the hash from preview and preserves a changed file', async () => {
	const bytes = new TextEncoder().encode('old note');
	const event = { ...file('notes/a.md', 'abc'), sha256: await sha256Hex(bytes), size: bytes.length };
	let current = 'newer edit';
	const target = {
		isPathOccupied: async () => true,
		write: async (path: string, value: Uint8Array, expected: string | null) => {
			assert.equal(path, event.path);
			if (expected !== current) throw new Error('changed');
			current = new TextDecoder().decode(value);
		},
	};
	await assert.rejects(restoreVersionLocally(event, bytes, 'current', 'preview hash', target), /changed/);
	assert.equal(current, 'newer edit');
	assert.equal(await restoreVersionLocally(event, bytes, 'current', 'newer edit', target), event.path);
	assert.equal(current, 'old note');
});

test('copy restore finds an unoccupied sibling and writes it with a missing-file expectation', async () => {
	const bytes = new Uint8Array([1, 2, 3]);
	const sha256 = await sha256Hex(bytes);
	const event = { ...file('notes/图像.png', sha256), sha256 };
	const occupied = new Set(['notes/图像 (restored ' + sha256.slice(0, 12) + ').png']);
	const target = {
		isPathOccupied: async (path: string) => occupied.has(path),
		write: async (_path: string, value: Uint8Array, expected: string | null) => {
			assert.deepEqual(value, bytes);
			assert.equal(expected, null);
		},
	};
	assert.equal(
		await restoreVersionLocally(event, bytes, 'copy', 'ignored original hash', target),
		'notes/图像 (restored ' + sha256.slice(0, 12) + ' 2).png',
	);
});

test('restoration verifies historical bytes and refuses deletion events before attempting a write', async () => {
	const bytes = new Uint8Array([1, 2, 3]);
	const sha256 = await sha256Hex(bytes);
	const event = { ...file('notes/a.md', sha256), sha256 };
	const local = {
		isPathOccupied: async () => false,
		write: async () => assert.fail('must verify the historical content before writing'),
	};
	await assert.rejects(restoreVersionLocally(event, new Uint8Array([3, 2, 1]), 'current', null, local), /校验/);
	await assert.rejects(restoreVersionLocally(event, bytes.slice(1), 'copy', null, local), /校验/);
	await assert.rejects(restoreVersionLocally(deletion(event.path, 'deleted', []), bytes, 'current', null, local), /恢复/);
});

test('text preview rejects binary data and oversized text and accepts UTF-8 notes', () => {
	assert.equal(decodeVersionText('notes/a.md', new TextEncoder().encode('中文\n内容')), '中文\n内容');
	assert.equal(decodeVersionText('notes/a.md', new Uint8Array([0x00, 0x41])), null);
	assert.equal(decodeVersionText('notes/a.md', new Uint8Array([0xff])), null);
	assert.equal(decodeVersionText('notes/a.png', new TextEncoder().encode('binary')), null);
	assert.equal(decodeVersionText('notes/a.md', new Uint8Array(128 * 1024 + 1)), null);
});

test('line diff marks additions and removals and bounds work on large edits', () => {
	assert.deepEqual(buildVersionDiff('start\nlocal\nend', 'start\nhistory\nend'), [
		{ kind: 'same', text: 'start' },
		{ kind: 'delete', text: 'local' },
		{ kind: 'add', text: 'history' },
		{ kind: 'same', text: 'end' },
	]);
	assert.deepEqual(buildVersionDiff('', 'restored\n'), [
		{ kind: 'add', text: 'restored' },
	]);
	assert.deepEqual(buildVersionDiff('same', 'same\n'), [
		{ kind: 'delete', text: 'same' },
		{ kind: 'add', text: 'same' },
	]);
	assert.equal(buildVersionDiff('local\n'.repeat(850), 'other\n'.repeat(850)), null);
	assert.equal(buildVersionDiff('a\n'.repeat(1200), 'a\n'.repeat(1200)), null);
});
