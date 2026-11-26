import assert from 'node:assert/strict';
import test from 'node:test';
import type { VersionEvent } from '../src/core.ts';
import { buildConflictMerge, composeConflictMerge, findConflictBase } from '../src/conflict-resolution-model.ts';

test('keeps both independent changes from the same base', () => {
	const sections = buildConflictMerge(
		'# Note\nLocal heading\nContext\nOriginal ending\n',
		'# Note\nOriginal heading\nContext\nCloud ending\n',
		'# Note\nOriginal heading\nContext\nOriginal ending\n',
	);
	assert.ok(sections);
	assert.equal(composeConflictMerge(sections, []), '# Note\nLocal heading\nContext\nCloud ending\n');
});

test('requires an explicit choice for each conflicting section', () => {
	const sections = buildConflictMerge(
		'# Note\nLocal heading\nContext\nLocal ending\n',
		'# Note\nCloud heading\nContext\nCloud ending\n',
		'# Note\nOriginal heading\nContext\nOriginal ending\n',
	);
	assert.ok(sections);
	assert.equal(composeConflictMerge(sections, ['local']), null);
	assert.equal(composeConflictMerge(sections, ['local', 'cloud']), '# Note\nLocal heading\nContext\nCloud ending\n');
});

test('lets users keep either concurrent insertion at the same base position', () => {
	const sections = buildConflictMerge('Before\nLocal addition\nAfter\n', 'Before\nCloud addition\nAfter\n', 'Before\nAfter\n');
	assert.ok(sections);
	assert.equal(composeConflictMerge(sections, []), null);
	assert.equal(composeConflictMerge(sections, ['cloud']), 'Before\nCloud addition\nAfter\n');
});

test('choosing an empty section removes the competing lines', () => {
	const sections = buildConflictMerge('First\nLast\n', 'First\nNew middle\nLast\n', 'First\nMiddle\nLast\n');
	assert.ok(sections);
	assert.equal(composeConflictMerge(sections, ['local']), 'First\nLast\n');
});

test('preserves the selected line endings and missing final newline without a common base', () => {
	const sections = buildConflictMerge('Same\r\nLocal\r\nAnchor\nLocal end', 'Same\r\nCloud\nAnchor\nCloud end\n', null);
	assert.ok(sections);
	assert.equal(composeConflictMerge(sections, ['local', 'cloud']), 'Same\r\nLocal\r\nAnchor\nCloud end\n');
});

test('requires a choice when the base is unavailable and only line endings differ', () => {
	const sections = buildConflictMerge('Text\r\n', 'Text\n', null);
	assert.ok(sections);
	assert.equal(composeConflictMerge(sections, []), null);
	assert.equal(composeConflictMerge(sections, ['cloud']), 'Text\n');
});

test('falls back to whole-version selection for a text comparison beyond the diff limit', () => {
	const local = 'Local\n'.repeat(501);
	const cloud = 'Cloud\n'.repeat(501);
	assert.equal(buildConflictMerge(local, cloud, null), null);
});

function version(id: string, parents: string[], kind: VersionEvent['kind'] = 'file'): VersionEvent {
	return { id, parents, kind, path: 'note.md', deviceId: 'device', createdAt: 10 };
}

test('uses the nearest shared file ancestor even when branch timestamps tie', () => {
	const base = version('base', ['root']);
	const history = [
		version('root', []), base, version('local', ['base']), version('cloud-parent', ['base']),
		version('cloud', ['cloud-parent']),
	];
	assert.equal(findConflictBase(history, 'local', 'cloud'), base);
});

test('does not resurrect an older file as the merge base after both branches recreate a deleted note', () => {
	const history = [
		version('root', []), version('deleted', ['root'], 'delete'),
		version('local', ['deleted']), version('cloud', ['deleted']),
	];
	assert.equal(findConflictBase(history, 'local', 'cloud'), null);
});

test('does not pick an arbitrary base when multiple shared ancestors are equally recent', () => {
	const history = [
		version('root', []), version('a', ['root']), version('b', ['root']),
		version('local', ['a', 'b']), version('cloud', ['a', 'b']),
	];
	assert.equal(findConflictBase(history, 'local', 'cloud'), null);
});

test('treats removing the final newline and appending another line as overlapping changes', () => {
	const sections = buildConflictMerge('First', 'First\nAppended\n', 'First\n');
	assert.ok(sections);
	assert.equal(composeConflictMerge(sections, []), null);
	assert.equal(composeConflictMerge(sections, ['cloud']), 'First\nAppended\n');
});
