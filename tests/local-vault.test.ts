import assert from 'node:assert/strict';
import test from 'node:test';
import type { App } from 'obsidian';
import { CONFLICT_DIRECTORY, LocalVaultAdapter } from '../src/local-vault.ts';

const asApp = (vault: unknown): App => ({ vault } as App);

test('conflict copy refuses a file created at the hidden destination during parent creation', async () => {
	const destination = `${CONFLICT_DIRECTORY}/notes/device-event.md`;
	const nodes = new Map<string, { type: 'file' | 'folder'; bytes?: Uint8Array }>();
	let writes = 0;
	const adapter = {
		exists: async (path: string) => nodes.has(path),
		stat: async (path: string) => nodes.has(path) ? { type: nodes.get(path)!.type } : null,
		mkdir: async (path: string) => {
			nodes.set(path, { type: 'folder' });
			if (path === `${CONFLICT_DIRECTORY}/notes`) {
				nodes.set(destination, { type: 'file', bytes: new Uint8Array([9]) });
			}
		},
		writeBinary: async (path: string, value: ArrayBuffer) => {
			writes += 1;
			nodes.set(path, { type: 'file', bytes: new Uint8Array(value) });
		},
	};
	const app = asApp({
		getAbstractFileByPath: () => null,
		adapter,
	});
	const local = new LocalVaultAdapter(app);
	await assert.rejects(
		local.write(destination, new Uint8Array([1, 2]), '.obsidian', true),
		/冲突副本路径已出现/,
	);
	assert.equal(writes, 0);
	assert.deepEqual([...nodes.get(destination)!.bytes!], [9]);
});

test('canonical write refuses to overwrite bytes that changed after the scan', async () => {
	const original = new Uint8Array([2]);
	const file = { path: 'notes.md', stat: { size: original.byteLength }, extension: 'md' };
	let modifications = 0;
	const app = asApp({
		getAbstractFileByPath: () => file,
		readBinary: async () => original,
		modifyBinary: async () => { modifications += 1; },
		adapter: { exists: async () => true },
	});
	const local = new LocalVaultAdapter(app);
	await assert.rejects(
		local.write('notes.md', new Uint8Array([3]), '.obsidian', false, 'previous-hash'),
		/本地文件已变化/,
	);
	assert.equal(modifications, 0);
});
