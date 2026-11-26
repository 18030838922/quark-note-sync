import assert from 'node:assert/strict';
import test from 'node:test';
import type { App } from 'obsidian';
import type { VersionEvent } from '../src/core.ts';
import { resolvePathEvents } from '../src/core.ts';
import { findDeferredAttachment, normalizeCloudAttachments } from '../src/cloud-attachments.ts';
import { sha256Hex } from '../src/hash.ts';
import { createBatchManifest } from '../src/manifest.ts';
import type { QuarkClient, RemoteFile } from '../src/quark-api.ts';
import { QuarkSyncService } from '../src/sync-service.ts';

const text = (value: string) => new TextEncoder().encode(value);

function makeCloud() {
	const entries = new Map<string, Map<string, RemoteFile>>();
	const contents = new Map<string, Uint8Array>();
	const folder = (fid: string) => {
		let children = entries.get(fid);
		if (!children) { children = new Map(); entries.set(fid, children); }
		return children;
	};
	const make = (parent: string, name: string, directory: boolean, bytes?: Uint8Array) => {
		const file = { fid: parent + '/' + name, name, isDirectory: directory, size: bytes?.byteLength ?? 0 };
		folder(parent).set(name, file);
		if (bytes) contents.set(file.fid, bytes);
		return file;
	};
	const client = {
		checkConnection: async () => 'account',
		listDirectory: async (parent: string) => [...folder(parent).values()],
		findChildByName: async (parent: string, name: string) => folder(parent).get(name),
		ensureFolder: async (parent: string, name: string) => (folder(parent).get(name) ?? make(parent, name, true)).fid,
		uploadFile: async (parent: string, name: string, bytes: Uint8Array) => make(parent, name, false, bytes),
		downloadFile: async (file: RemoteFile, _maxBytes?: number, progress?: (bytes: number) => void) => {
			progress?.(file.size);
			return contents.get(file.fid)!;
		},
	};
	const seedBranch = async (path: string, value: Uint8Array, deviceId: string, parents: string[] = []) => {
		const root = await client.ensureFolder('0', 'notes');
		const data = await client.ensureFolder(root, 'Obsidian Sync Data');
		const blobs = await client.ensureFolder(data, 'blobs');
		const events = await client.ensureFolder(data, 'events');
		const device = await client.ensureFolder(events, deviceId);
		const sha256 = await sha256Hex(value);
		const body: Omit<VersionEvent, 'id'> = { path, kind: 'file', parents, sha256, size: value.byteLength, deviceId, createdAt: 1 };
		const id = await sha256Hex(text(JSON.stringify(body)));
		const vaultId = await sha256Hex(text('quark-vault:' + root));
		const manifest = await createBatchManifest(vaultId, deviceId, [{ id, ...body }]);
		await client.uploadFile(blobs, sha256 + '.bin', value);
		await client.uploadFile(device, manifest.batchId + '.json', manifest.bytes);
		return { id, sha256 };
	};
	return { client: client as unknown as QuarkClient, seedBranch };
}

function makeDevice(client: QuarkClient, deviceId: string, mode = false) {
	const files = new Map<string, Uint8Array>();
	const get = (path: string) => files.has(path) ? { path, extension: path.split('.').pop(), stat: { size: files.get(path)!.byteLength } } : null;
	const app = {
		vault: {
			configDir: '.obsidian',
			getFiles: () => [...files.keys()].map(get),
			getAbstractFileByPath: get,
			readBinary: async ({ path }: { path: string }) => files.get(path)!.slice().buffer,
			createBinary: async (path: string, bytes: ArrayBuffer) => { files.set(path, new Uint8Array(bytes)); },
			modifyBinary: async ({ path }: { path: string }, bytes: ArrayBuffer) => { files.set(path, new Uint8Array(bytes)); },
			adapter: { exists: async (path: string) => files.has(path) },
		},
		fileManager: { trashFile: async ({ path }: { path: string }) => { files.delete(path); } },
	} as unknown as App;
	const state = { deviceId, snapshots: {}, pendingApplies: {}, cloudAttachments: normalizeCloudAttachments(undefined), persist: async () => {} };
	const service = new QuarkSyncService(app, client, { cloudDirectoryName: 'notes', attachmentsOnDemand: mode }, state);
	return { service, files, state };
}

test('on-demand attachment downloads, pins and clears locally while preserving the cloud record', async () => {
	const cloud = makeCloud();
	const local = makeDevice(cloud.client, 'phone', true);
	const path = 'lecture.pdf';
	const original = text('original');
	const { id } = await cloud.seedBranch(path, original, 'desktop');
	await cloud.seedBranch('lecture.md', text('[[lecture.pdf]]'), 'desktop');
	const preview = await local.service.preview();
	assert.equal(preview.paths.find((item) => item.path === path)?.deferred, true);
	assert.equal((await local.service.sync()).downloaded, 1);
	assert.equal(local.files.has(path), false);
	assert.equal(local.state.cloudAttachments[path].deferred, true);
	assert.equal(findDeferredAttachment(local.state.cloudAttachments, 'lecture.pdf', 'lecture.md'), path);
	const received: number[] = [];
	await local.service.downloadAttachment(path, true, (progress) => received.push(progress.bytes ?? 0));
	assert.deepEqual(local.files.get(path), original);
	assert.deepEqual(received, [0, original.byteLength]);
	assert.equal(local.state.cloudAttachments[path].pinned, true);
	local.files.set(path, text('edited'));
	await assert.rejects(() => local.service.evictAttachment(path), /未同步的改动/);
	local.files.set(path, original);
	await local.service.evictAttachment(path);
	assert.equal(local.files.has(path), false);
	assert.equal(local.state.cloudAttachments[path].deferred, true);
	assert.equal(local.state.cloudAttachments[path].pinned, false);
	assert.equal((await local.service.preview()).events.length, 0);
	await local.service.sync();
	assert.deepEqual((await local.service.versionHistory()).filter((event) => event.path === path).map((event) => event.id), [id]);

	const next = text('new edition');
	await cloud.seedBranch(path, next, 'desktop', [id]);
	await local.service.sync();
	assert.equal(local.state.cloudAttachments[path].size, next.byteLength);
	await local.service.downloadAttachment(path, false);
	assert.deepEqual(local.files.get(path), next);
});

test('conflict resolution rejects stale requests and preserves unpublished local edits before resolving', async () => {
	const cloud = makeCloud();
	const local = makeDevice(cloud.client, 'resolver');
	const path = 'note.md';
	const first = await cloud.seedBranch(path, text('base'), 'desktop');
	const one = await cloud.seedBranch(path, text('from desktop'), 'desktop', [first.id]);
	const two = await cloud.seedBranch(path, text('from tablet'), 'tablet', [first.id]);
	local.files.set(path, text('from desktop'));
	assert.equal((await local.service.listConflicts()).length, 1);
	const initial = await local.service.previewConflict(path, two.id);
	assert.deepEqual(initial.cloudBytes, text('from tablet'));
	assert.deepEqual(initial.baseBytes, text('base'));
	const request = { path, cloudVersionId: two.id, expectedHeadIds: initial.headIds, expectedLocalHash: initial.localHash, choice: { kind: 'cloud' as const } };
	const unpublished = text('an unpublished local edit');
	local.files.set(path, unpublished);
	await assert.rejects(() => local.service.resolveConflict(request, async () => {}), /本地文件已变化/);
	await assert.rejects(() => local.service.resolveConflict({ ...request, expectedHeadIds: [one.id] }, async () => {}), /云端版本已变化/);
	const preview = await local.service.previewConflict(path, two.id);
	await local.service.resolveConflict({ ...request, expectedLocalHash: preview.localHash }, async () => {});
	assert.deepEqual(local.files.get(path), text('from tablet'));
	assert.deepEqual(await local.service.listConflicts(), []);
	const events = await local.service.versionHistory();
	const retained = events.find((event) => event.sha256 === preview.localHash);
	assert.ok(retained);
	assert.deepEqual(retained.parents.sort(), [one.id, two.id].sort());
	const merged = resolvePathEvents(events);
	assert.equal(merged.heads.length, 1);
	assert.equal(merged.winner?.sha256, two.sha256);
	assert.deepEqual(merged.winner?.parents, [retained.id]);
});
