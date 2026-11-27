import { FileView, ItemView, MarkdownView, Notice, type Editor, type TFile, type WorkspaceLeaf } from 'obsidian';
import { collectNoteReferences, getReferenceReplacement, indexLocalCopies, verifyReferences } from './reference-manager.ts';
import type { QuarkReferenceRow, QuarkReferenceTarget, ReferenceStatus } from './reference-manager.ts';
import { managedDownloadPaths, type SourceIndex } from './source-index.ts';

export const QUARK_REFERENCE_MANAGER_VIEW_TYPE = 'quark-note-sync-reference-manager';

export interface QuarkReferenceManagerActions {
	language(): 'zh-CN' | 'en';
	sourceIndex(): SourceIndex;
	check(target: QuarkReferenceTarget, signal: AbortSignal): Promise<ReferenceStatus>;
	chooseReplacement(row: QuarkReferenceRow, signal: AbortSignal): Promise<string | undefined>;
}

class ReferenceChangedError extends Error {}

export class QuarkReferenceManagerView extends ItemView {
	private readonly actions: QuarkReferenceManagerActions;
	private readonly noteFiles = new Map<string, TFile>();
	private rows: QuarkReferenceRow[] = [];
	private statuses = new Map<string, ReferenceStatus>();
	private operation: AbortController | undefined;
	private operationKind: 'scan' | 'verify' | 'replace' | undefined;
	private closed = true;
	private brokenOnly = false;
	private unreadable = 0;

	constructor(leaf: WorkspaceLeaf, actions: QuarkReferenceManagerActions) {
		super(leaf);
		this.actions = actions;
		this.navigation = false;
	}

	getViewType(): string { return QUARK_REFERENCE_MANAGER_VIEW_TYPE; }
	getDisplayText(): string { return this.label('夸克引用管理', 'Quark references'); }
	getIcon(): string { return 'link'; }

	async onOpen(): Promise<void> {
		this.closed = false;
		this.contentEl.addClass('quark-reference-manager');
		void this.refresh();
	}

	async onClose(): Promise<void> {
		this.closed = true;
		this.operation?.abort();
		this.operation = undefined;
		this.operationKind = undefined;
		this.noteFiles.clear();
		this.rows = [];
		this.statuses.clear();
	}

	async refresh(): Promise<void> {
		await this.run('scan', (signal) => this.scan(signal));
	}

	private async verify(): Promise<void> {
		await this.run('verify', async (signal) => {
			await this.scan(signal);
			const statuses = await verifyReferences(this.rows, (target, verification) => this.actions.check(target, verification), signal);
			if (!signal.aborted) this.statuses = statuses;
		});
	}

	private async scan(signal: AbortSignal): Promise<void> {
		const { vault } = this.app;
		const index = this.actions.sourceIndex();
		const localCopies = indexLocalCopies(index, (path) => vault.getFileByPath(path)?.stat.size);
		const downloadPaths = managedDownloadPaths(index);
		const openEditors = this.openEditors();
		const rows: QuarkReferenceRow[] = [];
		const files = new Map<string, TFile>();
		let unreadable = 0;
		for (const file of vault.getMarkdownFiles().sort((a, b) => a.path.localeCompare(b.path))) {
			if (signal.aborted) return;
			if (downloadPaths.has(file.path)) continue;
			try {
				const editor = openEditors.get(file)?.[0];
				const markdown = editor?.getValue() ?? await vault.cachedRead(file);
				const path = file.path;
				const references = await collectNoteReferences(path, markdown, localCopies);
				if (references.length && file.path === path) {
					files.set(path, file);
					rows.push(...references);
				}
			} catch {
				unreadable += 1;
			}
		}
		if (signal.aborted) return;
		this.noteFiles.clear();
		for (const [path, file] of files) this.noteFiles.set(path, file);
		this.rows = rows;
		this.unreadable = unreadable;
		const targetKeys = new Set(rows.map((row) => row.targetKey));
		for (const key of this.statuses.keys()) if (!targetKeys.has(key)) this.statuses.delete(key);
	}

	private openEditors(): Map<TFile, Editor[]> {
		const editors = new Map<TFile, Editor[]>();
		for (const { view } of this.app.workspace.getLeavesOfType('markdown')) {
			if (!(view instanceof MarkdownView) || view.getMode() !== 'source' || !view.file) continue;
			const existing = editors.get(view.file);
			if (existing) {
				if (!existing.includes(view.editor)) existing.push(view.editor);
			} else editors.set(view.file, [view.editor]);
		}
		return editors;
	}

	private async replace(row: QuarkReferenceRow): Promise<void> {
		await this.run('replace', async (signal) => {
			const selected = await this.actions.chooseReplacement(row, signal);
			if (!selected || signal.aborted) return;
			const file = this.noteFiles.get(row.notePath);
			const { vault } = this.app;
			const requireCurrentNote = () => {
				if (!file || vault.getFileByPath(row.notePath) !== file || signal.aborted) throw new ReferenceChangedError();
				return file;
			};
			const note = requireCurrentNote();
			const editors = this.openEditors().get(note);
			if (editors?.length) {
				const [editor] = editors;
				const current = editor.getValue();
				if (editors.some((other) => other.getValue() !== current)) throw new ReferenceChangedError();
				const edit = getReferenceReplacement(row, current, selected);
				if (!edit) throw new ReferenceChangedError();
				editor.replaceRange(edit.markdown, editor.offsetToPos(edit.from), editor.offsetToPos(edit.to));
			} else {
				await vault.process(note, (current) => {
					requireCurrentNote();
					if (this.openEditors().has(note)) throw new ReferenceChangedError();
					const edit = getReferenceReplacement(row, current, selected);
					if (!edit) throw new ReferenceChangedError();
					return current.slice(0, edit.from) + edit.markdown + current.slice(edit.to);
				});
			}
			if (signal.aborted) return;
			await this.scan(signal);
			if (!signal.aborted) new Notice(this.label('已替换夸克引用。', 'Quark reference replaced.'));
		});
	}

	private async run(kind: 'scan' | 'verify' | 'replace', task: (signal: AbortSignal) => Promise<void>): Promise<void> {
		if (this.closed || this.operation) return;
		const operation = new AbortController();
		this.operation = operation;
		this.operationKind = kind;
		this.render();
		try {
			await task(operation.signal);
		} catch (error) {
			if (operation.signal.aborted) return;
			new Notice(error instanceof ReferenceChangedError
				? this.label('引用或笔记已变化。请刷新列表后重试。', 'The reference or note changed. Refresh the list and try again.')
				: this.label('无法完成引用管理操作。', 'Could not complete the reference operation.'));
		} finally {
			if (this.operation === operation) {
				this.operation = undefined;
				this.operationKind = undefined;
				this.render();
			}
		}
	}

	private async openFile(path: string, line?: number): Promise<void> {
		const file = this.app.vault.getFileByPath(path);
		if (!file) {
			new Notice(this.label('本地文件已移除。请刷新列表。', 'The local file was removed. Refresh the list.'));
			return;
		}
		try {
			const { workspace } = this.app;
			let existing: WorkspaceLeaf | undefined;
			workspace.iterateRootLeaves((leaf) => {
				if (!existing && leaf.view instanceof FileView && leaf.view.file === file) existing = leaf;
			});
			const leaf = existing ?? workspace.getLeaf('tab');
			await leaf.openFile(file, { active: true, ...(line ? { eState: { line: line - 1 } } : {}) });
		} catch {
			new Notice(this.label('无法打开本地文件。', 'Could not open the local file.'));
		}
	}

	private render(focusFilter = false): void {
		if (this.closed) return;
		const content = this.contentEl;
		const busy = Boolean(this.operation);
		content.empty();
		content.createEl('h2', { text: this.getDisplayText() });
		const controls = content.createDiv({ cls: 'quark-reference-manager-actions' });
		this.addButton(controls, this.label('刷新列表', 'Refresh list'), () => this.refresh(), busy);
		this.addButton(controls, this.label('检查链接', 'Check links'), () => this.verify(), busy || !this.rows.length);
		const filter = this.addButton(controls, this.label('仅显示失效', 'Broken only'), () => {
			this.brokenOnly = !this.brokenOnly;
			this.render(content.ownerDocument.activeElement === filter);
		}, busy);
		filter.setAttribute('aria-pressed', String(this.brokenOnly));
		if (focusFilter) filter.focus({ preventScroll: true });
		if (this.operationKind === 'replace') {
			this.addButton(controls, this.label('取消选择', 'Cancel selection'), () => this.operation?.abort());
		}
		if (this.operationKind) {
			const status = {
				scan: this.label('正在读取笔记…', 'Reading notes…'),
				verify: this.label('正在检查链接…', 'Checking links…'),
				replace: this.label('请选择新的夸克文件。', 'Select a new Quark file.'),
			};
			content.createEl('p', { text: status[this.operationKind], attr: { role: 'status' } });
		}
		if (this.unreadable) content.createEl('p', {
			text: this.label(`有 ${this.unreadable} 篇笔记读取失败。`, `${this.unreadable} note(s) could not be read.`),
		});
		const rows = this.brokenOnly ? this.rows.filter((row) => this.statuses.get(row.targetKey) === 'broken') : this.rows;
		if (!rows.length && !busy) content.createEl('p', { text: this.brokenOnly
			? this.label('没有已确认失效的引用。', 'No references are confirmed broken.')
			: this.label('笔记库中没有夸克引用。', 'No Quark references were found in this vault.') });
		let list: HTMLUListElement | undefined;
		let path: string | undefined;
		for (const row of rows) {
			if (row.notePath !== path) {
				path = row.notePath;
				const section = content.createEl('section', { cls: 'quark-reference-manager-note' });
				const title = section.createEl('h3');
				this.addLink(title, path, () => this.openFile(row.notePath));
				list = section.createEl('ul');
			}
			const item = list!.createEl('li');
			const label = row.label || (row.target.kind === 'share'
				? this.label('夸克公开分享', 'Public Quark share') : this.label('夸克个人文件', 'Personal Quark file'));
			this.addLink(item, this.label(`${label} · 第 ${row.line} 行`, `${label} · Line ${row.line}`), () => this.openFile(row.notePath, row.line));
			const status = this.statuses.get(row.targetKey);
			const labels = {
				available: this.label('在线可用', 'Online'),
				broken: this.label('链接已失效', 'Broken link'),
				unknown: this.label('暂无法确认', 'Could not verify'),
			};
			item.createDiv({ text: status ? labels[status] : this.label('尚未检查', 'Not checked'), cls: 'quark-reference-manager-status' });
			if (!row.localCopies.length) {
				item.createDiv({ text: this.label('无本地副本', 'No offline copy'), cls: 'quark-reference-manager-status' });
			}
			for (const copy of row.localCopies) {
				const local = item.createDiv();
				local.createSpan({ text: this.label('本地副本 ', 'Offline copy ') });
				this.addLink(local, copy.localPath, () => this.openFile(copy.localPath));
			}
			if (status !== 'available') this.addButton(item, this.label('替换引用', 'Replace reference'), () => this.replace(row), busy);
		}
	}

	private addButton(parent: HTMLElement, text: string, action: () => void | Promise<void>, disabled = false): HTMLButtonElement {
		const button = parent.createEl('button', { text, attr: { type: 'button' } });
		button.disabled = disabled;
		button.addEventListener('click', () => void action());
		return button;
	}

	private addLink(parent: HTMLElement, text: string, action: () => Promise<void>): void {
		const anchor = parent.createEl('a', { text, attr: { href: '#' } });
		anchor.addEventListener('click', (event) => {
			event.preventDefault();
			void action();
		});
	}

	private label(zh: string, en: string): string {
		return this.actions.language() === 'en' ? en : zh;
	}
}
