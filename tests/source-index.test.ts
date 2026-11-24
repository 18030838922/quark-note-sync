import assert from 'node:assert/strict';
import test from 'node:test';
import {
	chooseDownloadPath,
	addSourceIndexEntry,
	managedDownloadPaths,
	moveSourceIndexPath,
	normalizeSourceIndex,
	sourceIndexKey,
} from '../src/source-index.ts';

test('download paths stay inside the visible Quark Downloads folder and avoid existing names', () => {
	assert.equal(chooseDownloadPath('photo.png', new Set()), 'Quark Downloads/photo.png');
	assert.equal(chooseDownloadPath('photo.png', new Set(['Quark Downloads/photo.png'])), 'Quark Downloads/photo (2).png');
	assert.equal(chooseDownloadPath('archive', new Set(['Quark Downloads/archive'])), 'Quark Downloads/archive (2)');
	assert.equal(chooseDownloadPath('../notes.md', new Set()), 'Quark Downloads/.._notes.md');
	assert.equal(chooseDownloadPath('CON.txt', new Set()), 'Quark Downloads/_CON.txt');
	assert.equal(chooseDownloadPath('PHOTO.PNG', new Set(['quark downloads/photo.png'])), 'Quark Downloads/PHOTO (2).PNG');
	assert.throws(() => chooseDownloadPath('notes.md', new Set(['Quark Downloads'])), /occupied/);
	assert.equal(chooseDownloadPath('photo.png', new Set(['Quark Downloads/photo.png/child.txt'])), 'Quark Downloads/photo (2).png');
});

test('device-local source index accepts safe account-bound metadata and drops invalid entries', () => {
	const accountKey = 'a'.repeat(64);
	assert.equal(sourceIndexKey(accountKey, 'fid_2'), `${accountKey}/fid_2`);
	const result = normalizeSourceIndex({
		[`${accountKey}/fid_2`]: {
			accountKey, fid: 'fid_2', name: 'photo.png', size: 12,
			localPath: 'Quark Downloads/photo.png', sha256: 'a'.repeat(64), downloadedAt: 100,
		},
		bad: {
			accountKey, fid: 'fid_2', name: 'photo.png', size: 12,
			localPath: 'notes/photo.png', sha256: 'a'.repeat(64), downloadedAt: 100,
		},
	});
	assert.deepEqual(Object.keys(result), [`${accountKey}/fid_2`]);
	assert.equal(JSON.stringify(result).includes('cookie'), false);
});

test('renames inside Quark Downloads keep ownership while moving out relinquishes it', () => {
	const accountKey = 'a'.repeat(64);
	const key = `${accountKey}/fid_2`;
	const index = normalizeSourceIndex({
		[key]: { accountKey, fid: 'fid_2', name: 'photo.png', size: 12,
			localPath: 'Quark Downloads/photo.png', sha256: 'a'.repeat(64), downloadedAt: 100 },
	});
	const moved = moveSourceIndexPath(index, 'Quark Downloads/photo.png', 'Quark Downloads/renamed.png');
	assert.equal(moved[key].localPath, 'Quark Downloads/renamed.png');
	assert.deepEqual([...managedDownloadPaths(moved)].sort(), [
		'Quark Downloads/photo.png', 'Quark Downloads/renamed.png',
	].sort());
	const ordinary = moveSourceIndexPath(moved, 'Quark Downloads/renamed.png', 'notes/renamed.png');
	assert.equal(Object.prototype.hasOwnProperty.call(ordinary, key), false);
	assert.deepEqual([...managedDownloadPaths(ordinary)], []);
});

test('redownloading a removed source retains its former path reservation', () => {
	const accountKey = 'a'.repeat(64);
	const key = `${accountKey}/fid_2`;
	const first = normalizeSourceIndex({
		[key]: { accountKey, fid: 'fid_2', name: 'photo.png', size: 12,
			localPath: 'Quark Downloads/photo.png', sha256: 'a'.repeat(64), downloadedAt: 100 },
	});
	const next = addSourceIndexEntry(first, {
		accountKey, fid: 'fid_2', name: 'photo.png', size: 12,
		localPath: 'Quark Downloads/photo (2).png', sha256: 'b'.repeat(64), downloadedAt: 200,
	});
	assert.deepEqual([...managedDownloadPaths(next)].sort(), [
		'Quark Downloads/photo (2).png', 'Quark Downloads/photo.png',
	].sort());
	assert.equal(normalizeSourceIndex(next)[`${key}#Quark%20Downloads%2Fphoto.png`].localPath, 'Quark Downloads/photo.png');
});
