import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256Hex } from '../src/hash.ts';
import { accountReferenceKey, formatPersonalReference, parsePersonalReference } from '../src/quark-references.ts';
import { buildSyncPlan } from '../src/sync-engine.ts';

test('a second device receives the original Quark reference without an offline copy', async () => {
	const encoder = new TextEncoder();
	const accountKey = await accountReferenceKey('shared-account');
	const markdown = formatPersonalReference('Lesson.mp4', accountKey, 'lesson-file');
	const noteBytes = encoder.encode(markdown);
	const offlineBytes = encoder.encode('local preview fixture');
	const note = { path: 'Course.md', sha256: await sha256Hex(noteBytes), size: noteBytes.byteLength };
	const offlineCopy = {
		path: 'Quark Downloads/Lesson.mp4',
		sha256: await sha256Hex(offlineBytes),
		size: offlineBytes.byteLength,
	};
	const upload = await buildSyncPlan({
		localFiles: [note, offlineCopy],
		presentPaths: [note.path, offlineCopy.path],
		managedPaths: [offlineCopy.path],
		snapshots: {},
		remoteEvents: [],
		deviceId: 'pc',
		now: 1,
	});
	assert.deepEqual(upload.events.map(({ path }) => path), [note.path]);
	assert.equal(upload.events[0].sha256, note.sha256);

	const receive = await buildSyncPlan({
		localFiles: [],
		presentPaths: [],
		snapshots: {},
		remoteEvents: upload.events,
		deviceId: 'phone',
		now: 2,
	});
	assert.deepEqual(receive.paths.map(({ path }) => path), [note.path]);
	assert.equal(receive.paths[0].result.winner?.sha256, await sha256Hex(noteBytes));
	assert.equal(receive.events.length, 0);
	const referenceUrl = markdown.slice(markdown.indexOf('](') + 2, -1);
	assert.deepEqual(parsePersonalReference(referenceUrl), { accountKey, fid: 'lesson-file' });
});
