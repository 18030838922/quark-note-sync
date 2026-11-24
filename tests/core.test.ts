import assert from 'node:assert/strict';
import test from 'node:test';
import {
	MAX_FILE_BYTES,
	isSyncablePath,
	recoverPendingApply,
	resolvePathEvents,
	validatePathSet,
	validateVaultPath,
} from '../src/core.ts';

const file = (id: string, parents: string[], sha256: string, deviceId = 'pc') => ({
	id,
	path: '课程/计划.md',
	kind: 'file' as const,
	parents,
	sha256,
	size: 10,
	deviceId,
	createdAt: 10,
});

test('concurrent edits keep a deterministic primary and a second copy', () => {
	const result = resolvePathEvents([
		file('base', [], 'hash-base'),
		file('edit-b', ['base'], 'hash-b', 'tablet'),
		file('edit-a', ['base'], 'hash-a'),
	]);

	assert.equal(result.deleted, false);
	assert.equal(result.winner?.id, 'edit-a');
	assert.deepEqual(result.conflictCopies.map((event) => event.id), ['edit-b']);
	assert.deepEqual(result.heads.map((event) => event.id), ['edit-a', 'edit-b']);
});

test('concurrent heads with identical bytes remain in history without duplicate copies', () => {
	const result = resolvePathEvents([
		file('base', [], 'hash-base'),
		file('edit-a', ['base'], 'same-content', 'pc'),
		file('edit-b', ['base'], 'same-content', 'tablet'),
	]);
	assert.equal(result.heads.length, 2);
	assert.equal(result.winner?.sha256, 'same-content');
	assert.deepEqual(result.conflictCopies, []);
});

test('a deletion concurrent with an edit preserves the edited content', () => {
	const result = resolvePathEvents([
		file('base', [], 'hash-base'),
		{ id: 'delete', path: '课程/计划.md', kind: 'delete' as const, parents: ['base'], deviceId: 'pc', createdAt: 20 },
		file('edit', ['base'], 'hash-edited', 'tablet'),
	]);

	assert.equal(result.deleted, false);
	assert.equal(result.winner?.id, 'edit');
	assert.deepEqual(result.conflictCopies, []);
	assert.equal(result.concurrent, true);
});

test('a single deletion head is the only state that deletes the path', () => {
	const result = resolvePathEvents([
		file('base', [], 'hash-base'),
		{ id: 'delete', path: '课程/计划.md', kind: 'delete' as const, parents: ['base'], deviceId: 'pc', createdAt: 20 },
	]);

	assert.equal(result.deleted, true);
	assert.equal(result.winner, undefined);
});

test('missing parents mark history incomplete instead of guessing the current version', () => {
	assert.throws(
		() => resolvePathEvents([file('edit', ['not-downloaded'], 'hash-a')]),
		/历史不完整/,
	);
});

test('file history rejects versions outside the supported size limit', () => {
	assert.throws(
		() => resolvePathEvents([{ ...file('too-large', [], 'hash'), size: MAX_FILE_BYTES + 1 }]),
		/大小上限/,
	);
});

test('a disconnected history cycle is rejected even when another valid head exists', () => {
	assert.throws(
		() => resolvePathEvents([
			file('valid', [], 'hash-valid'),
			file('cycle-a', ['cycle-b'], 'hash-a'),
			file('cycle-b', ['cycle-a'], 'hash-b'),
		]),
		/循环/,
	);
});

test('history rejects duplicate, self, and cross-path parents', () => {
	assert.throws(() => resolvePathEvents([file('root', [], 'hash'), file('child', ['root', 'root'], 'hash2')]), /重复父版本/);
	assert.throws(() => resolvePathEvents([file('self', ['self'], 'hash')]), /循环/);
	assert.throws(
		() => resolvePathEvents([
			file('other-path-root', [], 'hash'),
			{ ...file('child', ['other-path-root'], 'hash2'), path: 'other.md' },
		]),
		/跨越了多个路径/,
	);
});

test('vault paths reject traversal and plugin state paths', () => {
	assert.equal(validateVaultPath('课程/计划.md'), '课程/计划.md');
	assert.throws(() => validateVaultPath('../secrets.md'), /路径/);
	assert.throws(() => validatePathSet(['.obsidian/plugins/x/data.json'], '.obsidian'), /路径/);
	assert.throws(() => validateVaultPath('a\\..\\secrets.md'), /路径/);
	assert.throws(() => validateVaultPath('.trash/recovered.md'), /路径/);
	assert.throws(() => validateVaultPath('notes/CON.md'), /路径/);
	assert.throws(() => validateVaultPath('notes/title?.md'), /路径/);
	assert.throws(() => validateVaultPath('notes/trailing. '), /路径/);
	assert.throws(() => validateVaultPath('notes/COM¹.md'), /路径/);
});

test('path sets reject Windows case or Unicode collisions and file-directory collisions', () => {
	assert.throws(() => validatePathSet(['Notes/Index.md', 'notes/index.md'], '.obsidian'), /冲突/);
	assert.throws(() => validatePathSet(['Notes/Ａ.md', 'Notes/A.md'], '.obsidian'), /冲突/);
	assert.throws(() => validatePathSet(['same.md', 'same.md'], '.obsidian'), /冲突/);
	assert.throws(() => validatePathSet(['folder', 'folder/child.md'], '.obsidian'), /冲突/);
	assert.throws(() => validatePathSet(['Foo/a.md', 'foo/b.md'], '.obsidian'), /冲突/);
	assert.throws(() => validatePathSet(['private/data.md'], 'private'), /配置/);
	assert.deepEqual(validatePathSet(['a.md', '附件/图.png'], '.obsidian'), ['a.md', '附件/图.png']);
});

test('syncable file checks enforce the size cap and exclude local conflict/config state', () => {
	assert.equal(MAX_FILE_BYTES, 10 * 1024 * 1024);
	assert.equal(isSyncablePath('附件/图.png', 1024, '.obsidian'), true);
	assert.equal(isSyncablePath('大文件.zip', MAX_FILE_BYTES + 1, '.obsidian'), false);
	assert.equal(isSyncablePath('.obsidian/plugins/quark-note-sync/data.json', 100, '.obsidian'), false);
	assert.equal(isSyncablePath('.quark-sync-conflicts/计划.md', 100, '.obsidian'), false);
	assert.equal(isSyncablePath('local/state.md', 100, 'local'), false);
});

test('pending apply recovery distinguishes completed, retryable, and user-edited files', () => {
	const pending = { beforeHash: 'old', desiredHash: 'remote' };
	assert.equal(recoverPendingApply('remote', pending), 'finish');
	assert.equal(recoverPendingApply('old', pending), 'retry');
	assert.equal(recoverPendingApply('new-local-edit', pending), 'preserve-local');
});
