import assert from 'node:assert/strict';
import test from 'node:test';
import {
	MAX_DOCUMENT_PREVIEW_BYTES,
	MAX_MEDIA_PREVIEW_BYTES,
	MAX_PERSONAL_DOWNLOAD_BYTES,
	MAX_IMAGE_PREVIEW_BYTES,
	accountReferenceKey,
	formatPersonalReference,
	findOfficialShareUrl,
	findOfficialShareLinks,
	formatPublicShareReference,
	parseOfficialShareUrl,
	parsePersonalReference,
	previewKindForFile,
	mimeTypeForFile,
} from '../src/quark-references.ts';
import { findPersonalReferenceLinks } from '../src/quark-references.ts';

test('personal references are ordinary Markdown links bound to a hashed account key and file ID only', async () => {
	const accountKey = 'a'.repeat(64);
	const markdown = formatPersonalReference('A [photo].png', accountKey, 'file_456');
	assert.equal(markdown, `[A \\[photo\\].png](obsidian://quark-note?account=${accountKey}&fid=file_456)`);
	assert.deepEqual(parsePersonalReference(`obsidian://quark-note?account=${accountKey}&fid=file_456`), {
		accountKey,
		fid: 'file_456',
	});
	assert.equal(/cookie|token|secret|password/i.test(markdown), false);
	assert.match(await accountReferenceKey('quark-user-123'), /^[a-f\d]{64}$/);
});

test('personal references reject other actions, malformed IDs, and embedded secrets', () => {
	assert.equal(parsePersonalReference(`obsidian://quark-note?account=${'a'.repeat(64)}&fid=fid&token=secret`), null);
	assert.equal(parsePersonalReference(`obsidian://user@quark-note?account=${'a'.repeat(64)}&fid=fid`), null);
	assert.equal(parsePersonalReference(`obsidian://quark-note:1234?account=${'a'.repeat(64)}&fid=fid`), null);
	assert.equal(parsePersonalReference(`obsidian://quark-note?account=${'a'.repeat(64)}&fid=fid#fragment`), null);
	assert.equal(parsePersonalReference(`obsidian://other?account=${'a'.repeat(64)}&fid=fid`), null);
	assert.equal(parsePersonalReference(`obsidian://quark-note?account=${'a'.repeat(64)}%0A&fid=fid`), null);
	assert.equal(parsePersonalReference(`obsidian://quark-note?account=${'a'.repeat(64)}`), null);
});

test('Live Preview parsing finds personal link and embed spans while rejecting unrelated URLs', () => {
	const account = 'b'.repeat(64);
	const markdown = `prefix [photo.png](obsidian://quark-note?account=${account}&fid=file_1) and ![audio](obsidian://quark-note?account=${account}&fid=file_2) [web](https://example.com)`;
	const matches = findPersonalReferenceLinks(markdown);
	assert.equal(matches.length, 2);
	assert.equal(markdown.slice(matches[0].from, matches[0].to), `[photo.png](obsidian://quark-note?account=${account}&fid=file_1)`);
	assert.deepEqual(matches.map((match) => ({ label: match.label, embedded: match.embedded, fid: match.reference.fid })), [
		{ label: 'photo.png', embedded: false, fid: 'file_1' },
		{ label: 'audio', embedded: true, fid: 'file_2' },
	]);
});

test('only official Quark public share URLs are recognized and passcodes are parsed in memory', () => {
	assert.deepEqual(parseOfficialShareUrl('https://pan.quark.cn/s/fd011e40f95d?pwd=2468#/list/share'), {
		pwdId: 'fd011e40f95d',
		passcode: '2468',
		officialUrl: 'https://pan.quark.cn/s/fd011e40f95d#/list/share',
	});
	assert.equal(parseOfficialShareUrl('https://pan.quark.cn/s/fd011e40f95d#/list/share/dir-2')?.pwdId, 'fd011e40f95d');
	assert.equal(parseOfficialShareUrl('https://example.com/s/fd011e40f95d'), null);
	assert.equal(parseOfficialShareUrl('https://pan.quark.cn.evil.test/s/fd011e40f95d'), null);
	assert.equal(parseOfficialShareUrl('https://pan.quark.cn/s/../account/info'), null);
	assert.equal(parseOfficialShareUrl('https://pan.quark.cn/s/fd011e40f95d#/evil-route'), null);
});

test('share URL discovery finds only an official link in pasted note text', () => {
	assert.equal(
		findOfficialShareUrl('See https://pan.quark.cn/s/fd011e40f95d?pwd=2468#/list/share in the note.'),
		'https://pan.quark.cn/s/fd011e40f95d?pwd=2468#/list/share',
	);
	assert.equal(findOfficialShareUrl('https://evil.example/s/fd011e40f95d'), null);
});

test('Live Preview parsing recognizes only official share links with selected file routes', () => {
	const markdown = '[image.png](https://pan.quark.cn/s/fd011e40f95d#/list/share/folder_1?fid=file_2) [bad](https://evil.example/s/fd011e40f95d)';
	const links = findOfficialShareLinks(markdown);
	assert.equal(links.length, 1);
	assert.equal(markdown.slice(links[0].from, links[0].to), '[image.png](https://pan.quark.cn/s/fd011e40f95d#/list/share/folder_1?fid=file_2)');
	assert.equal(links[0].label, 'image.png');
	assert.equal(links[0].reference.selectedFid, 'file_2');
});

test('public share Markdown references keep selected file identity but omit passcode and tokens', () => {
	const markdown = formatPublicShareReference('contract.pdf', 'fd011e40f95d', 'file-9', 'folder-2');
	assert.equal(markdown, '[contract.pdf](https://pan.quark.cn/s/fd011e40f95d#/list/share/folder-2?fid=file-9)');
	assert.equal(/pwd=|passcode|stoken|token=/i.test(markdown), false);
	assert.deepEqual(parseOfficialShareUrl(markdown.match(/\((.*)\)/)![1]), {
		pwdId: 'fd011e40f95d', passcode: '',
		officialUrl: 'https://pan.quark.cn/s/fd011e40f95d#/list/share/folder-2?fid=file-9',
		selectedParentFid: 'folder-2', selectedFid: 'file-9',
	});
});

test('preview classification distinguishes capped images and documents from media and fallback files', () => {
	assert.equal(MAX_PERSONAL_DOWNLOAD_BYTES, 100 * 1024 * 1024);
	assert.equal(MAX_IMAGE_PREVIEW_BYTES, 20 * 1024 * 1024);
	assert.equal(MAX_DOCUMENT_PREVIEW_BYTES, 20 * 1024 * 1024);
	assert.equal(MAX_MEDIA_PREVIEW_BYTES, 50 * 1024 * 1024);
	assert.deepEqual(previewKindForFile('photo.webp'), { kind: 'image', maxBytes: MAX_IMAGE_PREVIEW_BYTES });
	assert.deepEqual(previewKindForFile('report.pdf'), { kind: 'document', maxBytes: MAX_DOCUMENT_PREVIEW_BYTES });
	assert.deepEqual(previewKindForFile('recording.m4a'), { kind: 'audio', maxBytes: MAX_MEDIA_PREVIEW_BYTES });
	assert.deepEqual(previewKindForFile('movie.mp4'), { kind: 'video', maxBytes: MAX_MEDIA_PREVIEW_BYTES });
	assert.deepEqual(previewKindForFile('archive.zip'), { kind: 'unsupported', maxBytes: 0 });
	assert.equal(mimeTypeForFile('poster.jpeg'), 'image/jpeg');
	assert.equal(mimeTypeForFile('movie.mp4'), 'video/mp4');
	assert.equal(mimeTypeForFile('meeting.m4a'), 'audio/mp4');
	assert.equal(mimeTypeForFile('report.pdf'), 'application/pdf');
	assert.equal(mimeTypeForFile('notes.md'), 'text/plain');
});


test('insertion follows changes outside the selection and preserves edits inside it', async () => {
	const { mapInsertionRange } = await import('../src/quark-references.ts');
	assert.deepEqual(mapInsertionRange('prefix selected suffix', 'new prefix selected suffix', 7, 15), [11, 19]);
	assert.deepEqual(mapInsertionRange('prefix selected suffix', 'prefix selected suffix edited', 7, 15), [7, 15]);
	assert.equal(mapInsertionRange('prefix selected suffix', 'prefix changed suffix', 7, 15), null);
	assert.deepEqual(mapInsertionRange('before', 'before', 6, 6), [6, 6]);
});
