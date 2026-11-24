import assert from 'node:assert/strict';
import test from 'node:test';
import { applyIfCurrentHash } from '../src/safe-apply.ts';

test('a local edit made during earlier async work prevents the final canonical write', async () => {
	let currentHash: string | null = 'before';
	let writes = 0;
	await Promise.resolve().then(() => { currentHash = 'user-edit'; });
	const applied = await applyIfCurrentHash(
		async () => currentHash,
		'before',
		async () => { writes += 1; },
	);
	assert.equal(applied, false);
	assert.equal(writes, 0);
});

test('an unchanged local hash allows the guarded operation', async () => {
	let writes = 0;
	const applied = await applyIfCurrentHash(
		async () => 'before',
		'before',
		async () => { writes += 1; },
	);
	assert.equal(applied, true);
	assert.equal(writes, 1);
});
