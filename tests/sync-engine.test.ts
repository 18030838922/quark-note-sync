import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSyncPlan, type LocalFileState, type SyncSnapshot } from '../src/sync-engine.ts';
import type { VersionEvent } from '../src/core.ts';

const base: VersionEvent = {
	id: 'base',
	path: 'notes.md',
	kind: 'file',
	parents: [],
	sha256: 'hash-base',
	size: 10,
	deviceId: 'pc',
	createdAt: 1,
};

const edit = (id: string, sha256: string, deviceId: string, parents = ['base']): VersionEvent => ({
	id,
	path: 'notes.md',
	kind: 'file',
	parents,
	sha256,
	size: 11,
	deviceId,
	createdAt: 2,
});

const local = (path: string, sha256: string, size = 11): LocalFileState => ({ path, sha256, size });
const snapshot = (hash: string | null, heads: string[] = ['base']): Record<string, SyncSnapshot> => ({ 'notes.md': { hash, heads } });

test('first merge recognizes identical local and remote content without creating an event', async () => {
	const plan = await buildSyncPlan({
		localFiles: [local('notes.md', 'hash-base', 10)],
		presentPaths: ['notes.md'],
		snapshots: {},
		remoteEvents: [base],
		deviceId: 'tablet',
		now: 100,
	});
	assert.equal(plan.events.length, 0);
	assert.equal(plan.paths[0].result.winner?.id, 'base');
	assert.equal(plan.paths[0].nextSnapshot.hash, 'hash-base');
});

test('an offline local edit and remote edit become concurrent heads with a preserved copy', async () => {
	const plan = await buildSyncPlan({
		localFiles: [local('notes.md', 'hash-local')],
		presentPaths: ['notes.md'],
		snapshots: snapshot('hash-base'),
		remoteEvents: [base, edit('remote-edit', 'hash-remote', 'tablet')],
		deviceId: 'pc',
		now: 100,
	});
	assert.equal(plan.events.length, 1);
	assert.deepEqual(plan.events[0].parents, ['base']);
	assert.equal(plan.paths[0].result.heads.length, 2);
	assert.equal(plan.paths[0].result.conflictCopies.length, 1);
	assert.equal(new Set([plan.paths[0].result.winner?.sha256, plan.paths[0].result.conflictCopies[0].sha256]).size, 2);
});

test('a deleted local path does not tombstone an oversized path still present on disk', async () => {
	const plan = await buildSyncPlan({
		localFiles: [],
		presentPaths: ['notes.md'],
		protectedPaths: new Map([['notes.md', '超过 10 MiB，已跳过']]),
		snapshots: snapshot('hash-base'),
		remoteEvents: [base],
		deviceId: 'pc',
		now: 100,
	});
	assert.equal(plan.events.length, 0);
	assert.equal(plan.paths.length, 0);
	assert.match(plan.skipped[0].reason, /10 MiB/);
	assert.deepEqual(plan.nextSnapshots['notes.md'], { hash: 'hash-base', heads: ['base'] });
});

test('an unreadable file still present on disk is protected from becoming a tombstone', async () => {
	const plan = await buildSyncPlan({
		localFiles: [],
		presentPaths: ['notes.md'],
		protectedPaths: new Map([['notes.md', '本地读取失败，已跳过']]),
		snapshots: snapshot('hash-base'),
		remoteEvents: [base],
		deviceId: 'pc',
		now: 100,
	});
	assert.equal(plan.events.length, 0);
	assert.equal(plan.paths.length, 0);
	assert.match(plan.skipped[0].reason, /读取失败/);
});

test('missing acknowledged remote heads stop a path instead of rolling it back', async () => {
	const plan = await buildSyncPlan({
		localFiles: [local('notes.md', 'hash-base', 10)],
		presentPaths: ['notes.md'],
		snapshots: snapshot('hash-base', ['missing-acknowledged-head']),
		remoteEvents: [base],
		deviceId: 'pc',
		now: 100,
	});
	assert.equal(plan.events.length, 0);
	assert.equal(plan.paths.length, 0);
	assert.match(plan.skipped[0].reason, /缺少已确认的版本/);
});

test('a custom Obsidian config directory is never considered an incoming vault path', async () => {
	const privateEvent: VersionEvent = { ...base, id: 'private', path: 'private/data.json' };
	const plan = await buildSyncPlan({
		localFiles: [],
		presentPaths: [],
		snapshots: {},
		remoteEvents: [privateEvent],
		deviceId: 'pc',
		now: 100,
		configDir: 'private',
	});
	assert.equal(plan.paths.length, 0);
	assert.match(plan.skipped[0].reason, /配置/);
});

test('a local delete concurrent with a remote edit restores the edited version', async () => {
	const plan = await buildSyncPlan({
		localFiles: [],
		presentPaths: [],
		snapshots: snapshot('hash-base'),
		remoteEvents: [base, edit('remote-edit', 'hash-remote', 'tablet')],
		deviceId: 'pc',
		now: 100,
	});
	assert.equal(plan.events[0].kind, 'delete');
	assert.equal(plan.paths[0].result.deleted, false);
	assert.equal(plan.paths[0].result.winner?.sha256, 'hash-remote');
	assert.equal(plan.paths[0].result.conflictCopies.length, 0);
});

test('path collisions pause the affected plan before any local write', async () => {
	const collidingEvent: VersionEvent = { ...base, id: 'remote', path: 'Notes.md' };
	const plan = await buildSyncPlan({
		localFiles: [local('notes.md', 'local-hash')],
		presentPaths: ['notes.md'],
		snapshots: {},
		remoteEvents: [collidingEvent],
		deviceId: 'pc',
		now: 100,
	});
	assert.equal(plan.paths.length, 0);
	assert.equal(plan.events.length, 0);
	assert.match(plan.skipped[0].reason, /路径冲突/);
});

test('prototype-shaped vault names remain ordinary snapshot keys', async () => {
	const plan = await buildSyncPlan({
		localFiles: [local('__proto__', 'proto-hash'), local('constructor', 'constructor-hash'), local('toString', 'string-hash')],
		presentPaths: ['__proto__', 'constructor', 'toString'],
		snapshots: {},
		remoteEvents: [],
		deviceId: 'pc',
		now: 100,
	});
	assert.equal(plan.events.length, 3);
	assert.equal(Object.prototype.hasOwnProperty.call(plan.nextSnapshots, '__proto__'), true);
	assert.equal(plan.nextSnapshots['__proto__'].hash, 'proto-hash');
	const constructorPath = 'constructor';
	const stringPath = 'toString';
	assert.equal(plan.nextSnapshots[constructorPath].hash, 'constructor-hash');
	assert.equal(plan.nextSnapshots[stringPath].hash, 'string-hash');
});

test('indexed Quark downloads are excluded while ordinary files in the same folder stay syncable', async () => {
	const downloaded: VersionEvent = { ...base, id: 'download', path: 'Quark Downloads/photo.png', sha256: 'download-hash' };
	const ordinary: VersionEvent = { ...base, id: 'ordinary', path: 'Quark Downloads/my-attachment.txt', sha256: 'ordinary-hash' };
	const plan = await buildSyncPlan({
		localFiles: [local(downloaded.path, 'download-hash', 10), local(ordinary.path, 'ordinary-hash', 10)],
		presentPaths: [downloaded.path, ordinary.path],
		snapshots: {
			[downloaded.path]: { hash: 'download-hash', heads: ['download'] },
		},
		remoteEvents: [downloaded, ordinary],
		managedPaths: [downloaded.path],
		deviceId: 'pc',
		now: 100,
	});
	assert.deepEqual(plan.events, []);
	assert.deepEqual(plan.paths.map((path) => path.path), [ordinary.path]);
	assert.equal(Object.prototype.hasOwnProperty.call(plan.nextSnapshots, downloaded.path), false);
});
