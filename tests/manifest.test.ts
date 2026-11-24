import assert from 'node:assert/strict';
import test from 'node:test';
import { createBatchManifest, parseBatchManifest } from '../src/manifest.ts';
import type { VersionEvent } from '../src/core.ts';

const event: VersionEvent = {
	id: '93951802299be2feb47b1d876e23c8d177075cb3f6522261d6d333c2165f92b0',
	path: '课程/笔记.md',
	kind: 'file',
	parents: [],
	sha256: 'a'.repeat(64),
	size: 4,
	deviceId: 'device-1',
	createdAt: 100,
};

test('batch manifests round trip with content-addressed names and Chinese paths', async () => {
	const created = await createBatchManifest('vault-id', 'device-1', [event]);
	const parsed = await parseBatchManifest(created.bytes, 'vault-id', `${created.batchId}.json`);
	assert.equal(parsed.batchId, created.batchId);
	assert.equal(parsed.events[0].path, '课程/笔记.md');
	assert.equal(parsed.events[0].sha256, 'a'.repeat(64));
});

test('tampered event bytes, batch names, and foreign vault IDs are rejected', async () => {
	const created = await createBatchManifest('vault-id', 'device-1', [event]);
	const tampered = created.bytes.slice();
	tampered[tampered.length - 2] ^= 1;
	await assert.rejects(() => parseBatchManifest(tampered, 'vault-id', `${created.batchId}.json`), /清单校验/);
	await assert.rejects(() => parseBatchManifest(created.bytes, 'another-vault', `${created.batchId}.json`), /库不匹配/);
	await assert.rejects(() => parseBatchManifest(created.bytes, 'vault-id', 'wrong.json'), /文件名/);
});

test('event IDs must match their immutable contents', async () => {
	const created = await createBatchManifest('vault-id', 'device-1', [event]);
	const manifest = JSON.parse(new TextDecoder().decode(created.bytes));
	manifest.events[0].path = 'other.md';
	const mutated = new TextEncoder().encode(JSON.stringify(manifest));
	await assert.rejects(() => parseBatchManifest(mutated, 'vault-id', `${created.batchId}.json`), /清单校验|版本编号/);
});
