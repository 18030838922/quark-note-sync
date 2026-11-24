import assert from 'node:assert/strict';
import test from 'node:test';
import { createPairingCode, readPairingCode } from '../src/pairing-code.ts';
import type { PairingPayload } from '../src/pairing-code.ts';

const password = 'correct horse battery staple';
const payload: PairingPayload = {
	cookie: 'sid=secret-cookie-value; token=another-secret',
	cloudDirectoryName: 'Obsidian Vault',
	accountId: '123456789',
	rootFid: '987654321',
};
const createdAt = 1_800_000_000_000;

test('pairing codes round-trip payload through authenticated encryption without exposing the Cookie', async () => {
	const code = await createPairingCode(payload, password, createdAt);
	assert.match(code, /^QPS1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
	assert.ok(code.length <= 32 * 1024);
	assert.ok(!code.includes(payload.cookie));
	assert.ok(!code.includes('secret-cookie-value'));
	assert.deepEqual(await readPairingCode(code, password, createdAt + 1_000), payload);
});

test('pairing codes require a passphrase with at least 12 characters', async () => {
	await assert.rejects(() => createPairingCode(payload, 'short'), /12/);
	const code = await createPairingCode(payload, password, createdAt);
	await assert.rejects(() => readPairingCode(code, 'short', createdAt), /12/);
});

test('a wrong passphrase cannot decrypt a pairing code', async () => {
	const code = await createPairingCode(payload, password, createdAt);
	await assert.rejects(() => readPairingCode(code, 'a different passphrase', createdAt));
});

test('modified pairing code ciphertext is rejected', async () => {
	const code = await createPairingCode(payload, password, createdAt);
	const last = code.at(-1)!;
	const tampered = `${code.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;
	await assert.rejects(() => readPairingCode(tampered, password, createdAt));
});

test('pairing codes expire after 15 minutes', async () => {
	const code = await createPairingCode(payload, password, createdAt);
	await assert.rejects(() => readPairingCode(code, password, createdAt + 15 * 60 * 1_000), /过期/);
});

test('fresh pairing codes allow up to two minutes of slow-device clock skew', async () => {
	const code = await createPairingCode(payload, password, createdAt);
	assert.deepEqual(await readPairingCode(code, password, createdAt - 2 * 60 * 1_000), payload);
	await assert.rejects(() => readPairingCode(code, password, createdAt - 2 * 60 * 1_000 - 1), /有效期/);
});

test('unsupported versions and oversized input are rejected before decryption', async () => {
	await assert.rejects(() => readPairingCode('QPS2.abc.def.ghi', password, createdAt), /版本/);
	await assert.rejects(() => readPairingCode(`QPS1.${'A'.repeat(40_000)}`, password, createdAt), /长度/);
});

test('invalid account and Cookie fields are rejected before code creation', async () => {
	await assert.rejects(() => createPairingCode({ ...payload, cookie: 'sid=bad\r\nInjected: true' }, password, createdAt));
	await assert.rejects(() => createPairingCode({ ...payload, rootFid: '' }, password, createdAt));
});
