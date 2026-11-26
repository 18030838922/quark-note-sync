import assert from 'node:assert/strict';
import test from 'node:test';
import {
	collectNoteReferences, getReferenceReplacement, indexLocalCopies, publicShareReferenceKey,
	verifyReferences,
} from '../src/reference-manager.ts';
import type { SourceIndex } from '../src/source-index.ts';

const accountKey = 'a'.repeat(64);
const personalUrl = (fid: string) => `obsidian://quark-note?account=${accountKey}&fid=${fid}`;
const original = `![Original \\[filename\\]](${personalUrl('old')})`;
const replacement = `[Replacement](${personalUrl('replacement')})`;

function noteReferences(markdown: string) {
	return collectNoteReferences('Notes/Reading.md', markdown, new Map());
}

test('indexes personal, selected share and pasted share references while skipping example code and vault comments', async () => {
	const example = '[Example](' + personalUrl('example') + ')';
	const markdown = [
		'---', `draft: ${example}`, '---', `An inline example: \`${example}\``,
		'```md', example, '```', `%% ${example} %%`,
		original, '[Shared](https://pan.quark.cn/s/share1234#/list/share/folder?fid=pdf)',
		'<https://pan.quark.cn/s/another1234?pwd=abcd>',
	].join('\n');
	const records = await noteReferences(markdown);
	assert.deepEqual(records.map(({ label, line, notePath, target }) => [label, line, notePath, target.kind]), [
		['Original [filename]', 9, 'Notes/Reading.md', 'personal'],
		['Shared', 10, 'Notes/Reading.md', 'share'],
		['', 11, 'Notes/Reading.md', 'share'],
	]);
});

test('associates existing offline copies with both personal and selected share files', async () => {
	const shareKey = await publicShareReferenceKey('share1234');
	const entry = (owner: string, fid: string, name: string) => ({
		accountKey: owner, fid, name, localPath: `Quark Downloads/${name}`, size: 10, sha256: 'c'.repeat(64), downloadedAt: 1,
	});
	const index: SourceIndex = {
		[`${accountKey}/old`]: entry(accountKey, 'old', 'Current.png'),
		[`${accountKey}/old#previous`]: entry(accountKey, 'old', 'Previous.png'),
		[`${shareKey}/pdf`]: entry(shareKey, 'pdf', 'Shared.pdf'),
	};
	const copies = indexLocalCopies(index, (path) => path.endsWith('Current.png') ? undefined : 10);
	const records = await collectNoteReferences('Notes/Reading.md', `${original}\n[Shared](https://pan.quark.cn/s/share1234#/list/share/folder?fid=pdf)`, copies);
	assert.deepEqual(records.map((row) => row.localCopies.map(({ localPath }) => localPath)), [
		['Quark Downloads/Previous.png'], ['Quark Downloads/Shared.pdf'],
	]);
});

test('replaces only the selected link destination and preserves an unrelated note edit', async () => {
	const markdown = `Intro\n${original}\nAnother ${original}`;
	const row = (await noteReferences(markdown))[1];
	const current = 'New line\n' + markdown;
	const result = getReferenceReplacement(row, current, replacement);
	assert.ok(result);
	assert.equal(current.slice(0, result.from) + result.markdown + current.slice(result.to),
		`New line\nIntro\n${original}\nAnother ![Original \\[filename\\]](${personalUrl('replacement')})`);
});

test('refuses replacement when the selected occurrence was changed while the picker was open', async () => {
	const markdown = `Intro\n${original}`;
	const row = (await noteReferences(markdown))[0];
	assert.equal(getReferenceReplacement(row, markdown.replace('fid=old', 'fid=edited'), replacement), null);
	assert.equal(getReferenceReplacement(row, '```\n' + markdown, replacement), null);
	assert.equal(getReferenceReplacement(row, markdown, `${replacement}\nOther text`), null);
});

test('moves a pasted official share link to a valid personal Markdown link', async () => {
	const markdown = 'See <https://pan.quark.cn/s/share1234?pwd=abcd> for details.';
	const result = getReferenceReplacement((await noteReferences(markdown))[0], markdown, replacement);
	assert.ok(result);
	assert.equal(markdown.slice(0, result.from) + result.markdown + markdown.slice(result.to), `See ${replacement} for details.`);
});

test('keeps failed checks unknown, and reuses the result for repeated references', async () => {
	const rows = await noteReferences(`${original}\n${original}\n${replacement}`);
	let checks = 0;
	const statuses = await verifyReferences(rows, async (target) => {
		checks += 1;
		if (target.kind === 'personal' && target.reference.fid === 'old') throw new Error('access denied');
		return 'broken';
	}, new AbortController().signal);
	assert.deepEqual(rows.map((row) => statuses.get(row.targetKey)), ['unknown', 'unknown', 'broken']);
	assert.equal(checks, 2);
});


test('does not replace an occurrence that could have been duplicated during selection', async () => {
	const row = (await noteReferences(original))[0];
	assert.equal(getReferenceReplacement(row, `${original}${original}`, replacement), null);
});

test('reports the original display text of a link with inline code in its label', async () => {
	const rows = await noteReferences(`[\`example\`](${personalUrl('old')})`);
	assert.equal(rows[0]?.label, '`example`');
});

test('preserves and reindexes a titled angle-bracket link after replacing its share destination', async () => {
	const markdown = '[Shared](<https://pan.quark.cn/s/share1234> "Title")';
	const [row] = await noteReferences(markdown);
	assert.equal(row?.label, 'Shared');
	const result = getReferenceReplacement(row, markdown, replacement);
	assert.ok(result);
	const edited = markdown.slice(0, result.from) + result.markdown + markdown.slice(result.to);
	assert.equal(edited, `[Shared](<${personalUrl('replacement')}> "Title")`);
	const [updated] = await noteReferences(edited);
	assert.deepEqual(updated?.target, { kind: 'personal', reference: { accountKey, fid: 'replacement' } });
});
