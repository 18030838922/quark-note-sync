import assert from 'node:assert/strict';
import test from 'node:test';
import {
	normalizePersonalDirectoryShortcuts,
	PersonalFileSearch,
	type DirectoryCrumb,
} from '../src/personal-file-browser.ts';
import type { RemoteFile } from '../src/quark-api.ts';

const root: DirectoryCrumb = { fid: '0', name: 'Quark Drive' };
const archive: DirectoryCrumb = { fid: 'archive', name: 'Archive' };
const file = (fid: string, name: string, isDirectory = false): RemoteFile => ({ fid, name, isDirectory, size: 0 });

test('file-name search resumes pagination and retains each match’s real parent path', async () => {
	const search = new PersonalFileSearch('  RÉSUMÉ  ', [root]);
	const requested: string[] = [];
	const pages = new Map([
		['0:1', { entries: [file('archive', 'Archive', true)], total: 2 }],
		['0:2', { entries: [file('first', 'Résumé 2026.pdf')], total: 2 }],
		['archive:1', { entries: [
			file('second', 'RÉSUMÉ.docx'),
			file('third', 'notes.md'),
			file('folder', 'Résumé drafts', true),
		], total: 3 }],
		['folder:1', { entries: [], total: 0 }],
	]);
	const list = async (fid: string, page: number) => {
		requested.push(`${fid}:${page}`);
		return pages.get(`${fid}:${page}`)!;
	};

	await search.scan(list, () => true, 2);
	assert.deepEqual(requested, ['0:1', '0:2']);
	assert.equal(search.hasMore, true);
	assert.deepEqual(search.results.map(({ file, ancestors }) => [file.fid, ancestors]), [['first', [root]]]);

	await search.scan(list, () => true, 2);
	assert.equal(search.hasMore, false);
	assert.deepEqual(search.results.map(({ file, ancestors }) => [file.fid, ancestors]), [
		['first', [root]],
		['second', [root, archive]],
	]);
});

test('a superseded search ignores its inflight page and makes no further requests', async () => {
	const search = new PersonalFileSearch('notes', [root]);
	let active = true;
	let requested = 0;
	await search.scan(async () => {
		requested += 1;
		active = false;
		return { entries: [file('archive', 'Archive', true), file('notes', 'notes.md')], total: 2 };
	}, () => active);
	assert.equal(requested, 1);
	assert.deepEqual(search.results, []);
});

test('a failed page can be retried or skipped without publishing its results', async () => {
	const search = new PersonalFileSearch('notes', [root]);
	await search.scan(async () => ({
		entries: [file('archive', 'Archive', true), file('elsewhere', 'Elsewhere', true)],
		total: 2,
	}), () => true, 1);

	await assert.rejects(() => search.scan(async () => { throw new Error('Unreachable'); }, () => true), /Unreachable/);
	assert.deepEqual(search.nextFolder, [root, archive]);
	search.skipFolder();
	await search.scan(async (fid) => ({ entries: [file(fid + '-notes', 'notes.md')], total: 1 }), () => true);
	assert.equal(search.skippedFolders, 1);
	assert.deepEqual(search.results.map(({ file }) => file.fid), ['elsewhere-notes']);
});

test('directory shortcuts accept only valid unique personal directory paths', () => {
	const copy = { fid: 'archive', name: 'Old name' };
	const outside = { fid: 'outside', name: 'Other' };
	assert.deepEqual(normalizePersonalDirectoryShortcuts({
		recent: [[root], [root, archive], [root, copy], [outside, archive], [root, { ...archive, fid: '../bad' }]],
		favorites: [[root, archive], [root, outside], [root, archive, copy]],
	}), {
		recent: [[root, archive]],
		favorites: [[root, archive], [root, outside]],
	});
});
