import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSync } from 'esbuild';
import type { QuarkReferenceManagerView as ReferenceManagerView } from '../src/reference-manager-view.ts';

class Element extends EventTarget {
	readonly children: Element[] = [];

	constructor(readonly tag = 'div', readonly text = '', readonly ownerDocument: { activeElement?: Element } = {}) { super(); }
	addClass(): void {}
	setAttribute(): void {}
	focus(): void { this.ownerDocument.activeElement = this; }
	empty(): void {
		this.children.length = 0;
		this.ownerDocument.activeElement = undefined;
	}
	createEl(tag: string, { text = '' } = {}): Element {
		const child = new Element(tag, text, this.ownerDocument);
		this.children.push(child);
		return child;
	}
	createDiv(): Element { return this.createEl('div'); }
	createSpan(options: { text: string }): Element { return this.createEl('span', options); }
	find(tag: string, text: string): Element | undefined {
		if (this.tag === tag && this.text === text) return this;
		for (const child of this.children) {
			const match = child.find(tag, text);
			if (match) return match;
		}
	}
}

const bundle = buildSync({
	entryPoints: ['src/reference-manager-view.ts'],
	bundle: true,
	format: 'cjs',
	platform: 'browser',
	external: ['obsidian'],
	write: false,
}).outputFiles[0].text;

const accountKey = 'a'.repeat(64);
const note = { path: 'Notes/Reading.md', stat: { size: 140 } };
const copy = { path: 'Quark Downloads/Reference.pdf', stat: { size: 24 } };
const offline = {
	accountKey, fid: 'file', name: 'Reference.pdf', localPath: copy.path, size: copy.stat.size,
	sha256: 'b'.repeat(64), downloadedAt: 1,
};

async function openManager() {
	const files = [note, copy];
	const leaves: Leaf[] = [];
	let manager: ReferenceManagerView;
	class FileView {
		constructor(readonly file: (typeof files)[number]) {}
	}
	class Leaf {
		view?: FileView | ReferenceManagerView;
		openState?: { active?: boolean; eState?: unknown };

		async openFile(file: (typeof files)[number], state: Leaf['openState']): Promise<void> {
			if (this.view === manager) await manager.onClose();
			this.view = new FileView(file);
			this.openState = state;
		}
	}
	function createTab(): Leaf {
		const leaf = new Leaf();
		leaves.push(leaf);
		return leaf;
	}
	const managerLeaf = createTab();
	const app = {
		vault: {
			getMarkdownFiles: () => [note],
			getFileByPath: (path: string) => files.find((file) => file.path === path),
			cachedRead: async () => `Reading\n[Reference](obsidian://quark-note?account=${accountKey}&fid=file)`,
		},
		workspace: {
			getLeavesOfType: () => [],
			getLeaf: (where: false | 'tab') => where === 'tab' ? createTab() : managerLeaf,
			iterateRootLeaves: (visit: (leaf: Leaf) => void) => leaves.forEach(visit),
		},
	};
	const requireObsidian = (name: string) => {
		assert.equal(name, 'obsidian');
		return {
			ItemView: class { app = app; contentEl = new Element(); },
			FileView,
			MarkdownView: class extends FileView {},
			Notice: class { constructor(message: string) { assert.fail(message); } },
		};
	};
	const commonJs = { exports: {} as { QuarkReferenceManagerView: typeof ReferenceManagerView } };
	new Function('require', 'module', bundle)(requireObsidian, commonJs);
	manager = new commonJs.exports.QuarkReferenceManagerView(managerLeaf as unknown as ConstructorParameters<typeof ReferenceManagerView>[0], {
		language: () => 'en', sourceIndex: () => ({ [`${accountKey}/file`]: offline }),
		check: async () => 'available', chooseReplacement: async () => undefined,
	});
	managerLeaf.view = manager;
	await manager.onOpen();
	await new Promise<void>((resolve) => setImmediate(resolve));
	const content = manager.contentEl as unknown as Element;
	return { manager, managerLeaf, leaves, content };
}

test('opening a reference line or offline copy preserves the manager tab', async () => {
	const { manager, managerLeaf, leaves, content } = await openManager();
	const line = content.find('a', 'Reference · Line 2');
	const offlineCopy = content.find('a', copy.path);
	assert.ok(line);
	assert.ok(offlineCopy);

	line.dispatchEvent(new Event('click', { cancelable: true }));
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(managerLeaf.view, manager);
	assert.deepEqual(leaves[1]?.openState, { active: true, eState: { line: 1 } });
	assert.equal((leaves[1]?.view as { file?: typeof note })?.file, note);

	offlineCopy.dispatchEvent(new Event('click', { cancelable: true }));
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(managerLeaf.view, manager);
	assert.equal((leaves[2]?.view as { file?: typeof copy })?.file, copy);
});

test('opening the same note again reuses its tab and jumps to the selected line', async () => {
	const { leaves, content } = await openManager();
	const title = content.find('a', note.path);
	const line = content.find('a', 'Reference · Line 2');
	assert.ok(title);
	assert.ok(line);

	title.dispatchEvent(new Event('click', { cancelable: true }));
	await new Promise<void>((resolve) => setImmediate(resolve));
	line.dispatchEvent(new Event('click', { cancelable: true }));
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(leaves.length, 2);
	assert.deepEqual(leaves[1]?.openState, { active: true, eState: { line: 1 } });
});

test('toggling the broken-only filter preserves keyboard focus', async () => {
	const { content } = await openManager();
	const filter = content.find('button', 'Broken only');
	assert.ok(filter);
	filter.focus();
	filter.dispatchEvent(new Event('click'));
	assert.equal(content.find('a', 'Reference · Line 2'), undefined);
	assert.ok(content.ownerDocument.activeElement === content.find('button', 'Broken only'), 'filter lost keyboard focus');
});
