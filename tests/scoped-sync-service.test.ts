import assert from 'node:assert/strict';
import test from 'node:test';
import type { App } from 'obsidian';
import { sha256Hex } from '../src/hash.ts';
import type { QuarkClient, RemoteFile } from '../src/quark-api.ts';
import { QuarkSyncService, type SyncProgress } from '../src/sync-service.ts';
import { normalizeSyncScope } from '../src/sync-scope.ts';

test('failed uploads leave the cloud history intact and retry syncs only the selected path', async () => {
	const files = new Map<string, Uint8Array>([
		['retry.md', Uint8Array.of(1)],
		['other.md', Uint8Array.of(2)],
		['excluded.pdf', Uint8Array.of(3)],
	]);
	const namedFile = (path: string) => ({ path, extension: path.split('.').at(-1), stat: { size: files.get(path)?.byteLength } });
	const app = { vault: {
		configDir: '.obsidian',
		getFiles: () => [...files.keys()].map(namedFile),
		getAbstractFileByPath: (path: string) => files.has(path) ? namedFile(path) : null,
		readBinary: async ({ path }: { path: string }) => files.get(path)?.slice().buffer,
	} } as unknown as App;
	const remote = new Map<string, Map<string, RemoteFile>>();
	const bytes = new Map<string, Uint8Array>();
	const kids = (parent: string): Map<string, RemoteFile> => {
		let folder = remote.get(parent);
		if (!folder) { folder = new Map(); remote.set(parent, folder); }
		return folder;
	};
	const create = (parent: string, name: string, isDirectory: boolean, size = 0): RemoteFile => {
		const file = { fid: parent + '/' + name, name, isDirectory, size };
		kids(parent).set(name, file);
		return file;
	};
	const failure = await sha256Hex(files.get('retry.md')!);
	let fail = true;
	const client = {
		checkConnection: async () => undefined,
		ensureFolder: async (parent: string, name: string) => (kids(parent).get(name) ?? create(parent, name, true)).fid,
		findChildByName: async (parent: string, name: string) => kids(parent).get(name),
		listDirectory: async (parent: string) => [...kids(parent).values()],
		downloadFile: async ({ fid }: RemoteFile) => bytes.get(fid)!,
		uploadFile: async (parent: string, name: string, content: Uint8Array, onProgress?: (sent: number) => void) => {
			if (fail && name === failure + '.bin') throw new Error('fixture upload interrupted');
			onProgress?.(content.byteLength);
			const file = create(parent, name, false, content.byteLength);
			bytes.set(file.fid, content);
			return file;
		},
	} as unknown as QuarkClient;
	const state = { deviceId: 'test-device', snapshots: {}, pendingApplies: {}, persist: async () => {} };
	const settings = { cloudDirectoryName: 'notes', syncScope: normalizeSyncScope({ extensions: ['md'] }) };
	const service = new QuarkSyncService(app, client, settings, state);
	const preview = await service.preview();
	assert.deepEqual(preview.events.map(({ path }) => path).sort(), ['other.md', 'retry.md']);
	const progress: SyncProgress[] = [];
	const initial = await service.sync(undefined, (event) => progress.push(event));
	assert.equal(initial.uploaded, 1);
	assert.deepEqual(initial.skipped, [{ path: 'retry.md', reason: 'fixture upload interrupted', retryable: true }]);
	assert.deepEqual((await service.versionHistory()).map(({ path }) => path), ['other.md']);
	assert.ok(progress.some((event) => event.phase === 'upload' && event.path === 'other.md' && event.bytes === 1));

	fail = false;
	files.set('later.md', Uint8Array.of(4));
	const retry = await service.sync('retry.md');
	assert.equal(retry.uploaded, 1);
	assert.deepEqual(retry.skipped, []);
	assert.deepEqual((await service.versionHistory()).map(({ path }) => path).sort(), ['other.md', 'retry.md']);
	assert.ok(files.has('excluded.pdf') && files.has('later.md'));

	// A previously synced file may be absent locally while this device excludes it.
	settings.syncScope = normalizeSyncScope({ folders: ['Other folder'] });
	files.delete('other.md');
	assert.deepEqual((await service.preview()).events, []);
	await service.sync();
	assert.deepEqual((await service.versionHistory()).filter(({ path }) => path === 'other.md').map(({ kind }) => kind), ['file']);
	assert.ok(Object.prototype.hasOwnProperty.call(state.snapshots, 'other.md'));
});
