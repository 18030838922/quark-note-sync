import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSyncScope, selectSyncScope } from '../src/sync-scope.ts';
import type { VersionEvent } from '../src/core.ts';

function version(id: string, path: string, size: number, parents: string[] = []): VersionEvent {
	return { id, path, size, parents, kind: 'file', deviceId: 'test', createdAt: 1, sha256: id };
}

test('scope intersects folders, extensions and local/cloud sizes without counting older versions', () => {
	const scope = normalizeSyncScope({ folders: ['Notes', '../invalid'], extensions: ['.MD'], maxBytes: 100 });
	const local = [{ path: 'Notes/local.md', size: 105 }, { path: 'Notes/available.MD', size: 80 }];
	const events = [
		version('old', 'Notes/old-large.md', 200),
		version('new', 'Notes/old-large.md', 90, ['old']),
		version('remote', 'Notes/cloud.md', 110),
		version('concurrent', 'Notes/cloud.md', 20),
		version('pdf', 'Notes/slides.pdf', 10),
		version('other', 'Notes 2/readme.md', 10),
	];
	const result = selectSyncScope(scope, local, events, ['Other/deleted-locally.md']);
	assert.deepEqual(result.included.sort(), ['Notes/available.MD', 'Notes/old-large.md']);
	assert.deepEqual(result.excluded.sort(), ['Notes 2/readme.md', 'Notes/cloud.md', 'Notes/local.md', 'Notes/slides.pdf', 'Other/deleted-locally.md']);
});

test('the default scope includes cloud-only data and previously tracked paths', () => {
	const result = selectSyncScope(normalizeSyncScope(undefined), [], [version('file', 'a.bin', 4 * 1024 ** 3)], ['removed.md']);
	assert.deepEqual(result, { included: ['removed.md', 'a.bin'], excluded: [] });
});
