import { Modal, Notice, type App } from 'obsidian';
import type { VersionEvent } from './core.ts';
import type { LocalContent } from './local-vault.ts';
import type { Language } from './settings-text.ts';
import {
	buildVersionDiff,
	decodeVersionText,
	type DeletedHistoryPath,
	type VersionRestoreMode,
} from './version-history-model.ts';

export interface VersionHistoryActions {
	language: Language;
	listVersions(path: string): Promise<VersionEvent[]>;
	listDeletedPaths(): Promise<DeletedHistoryPath[]>;
	previewVersion(event: VersionEvent): Promise<{ bytes: Uint8Array | null; current: LocalContent | null }>;
	restoreVersion(event: VersionEvent, mode: VersionRestoreMode, expectedCurrentHash: string | null): Promise<string>;
}

const historyText = {
	'zh-CN': {
		history: '文件版本历史',
		deleted: '云端已删除文件',
		loadDeleted: '正在查找可恢复的文件…',
		loadHistory: '正在读取版本历史…',
		loadPreview: '正在读取所选版本…',
		filter: '按路径搜索',
		noDeleted: '云端没有可恢复的已删除文件。',
		noResults: '没有匹配的路径。',
		noVersions: '云端没有此文件的版本记录。',
		deleteRecord: '删除记录',
		fileVersion: '文件版本',
		preview: '版本内容',
		diff: '与本地比较',
		copy: '恢复为副本',
		restore: '恢复到原路径',
		confirm: '确认恢复',
		confirmOverwrite: '将用所选版本替换原路径上的本地文件。原文件可能包含尚未同步的修改。',
		confirmCreate: '将在原路径创建文件。',
		restorePending: '正在恢复…',
		restored: '已恢复 ',
		cancel: '取消',
		close: '关闭',
		back: '返回',
		recoverDeleted: '查找云端已删除文件',
		loadMore: '加载更多',
		error: '读取版本历史失败。',
		restoreError: '无法恢复所选版本。',
		noPreview: '此版本无法提供文本预览。仍可恢复原始文件。',
		noDiff: '这两个版本无法提供文本差异。仍可查看版本信息并恢复文件。',
		noDiffLarge: '差异过多，无法显示逐行比较。可切换到版本内容查看所选文本。',
		diffLegend: '− 本地内容 · + 所选版本内容',
		lineEndings: '文件的换行格式或末尾换行不同。',
		local: '本地文件',
		absent: '原路径上没有本地文件。',
		same: '所选版本与本地文件内容相同。',
		different: '所选版本与本地文件内容不同。',
		binarySize: '字节',
	},
	en: {
		history: 'File version history',
		deleted: 'Files deleted in the cloud',
		loadDeleted: 'Finding recoverable files…',
		loadHistory: 'Loading version history…',
		loadPreview: 'Loading selected version…',
		filter: 'Search paths',
		noDeleted: 'There are no recoverable deleted files in the cloud.',
		noResults: 'No matching paths.',
		noVersions: 'This file has no version history in the cloud.',
		deleteRecord: 'Deletion',
		fileVersion: 'File version',
		preview: 'Version content',
		diff: 'Compare with local',
		copy: 'Restore as a copy',
		restore: 'Restore to original path',
		confirm: 'Confirm restore',
		confirmOverwrite: 'This will replace the local file at the original path with the selected version. The local file may contain changes that have yet to sync.',
		confirmCreate: 'This will create the file at its original path.',
		restorePending: 'Restoring…',
		restored: 'Restored ',
		cancel: 'Cancel',
		close: 'Close',
		back: 'Back',
		recoverDeleted: 'Find files deleted in the cloud',
		loadMore: 'Load more',
		error: 'Could not load version history.',
		restoreError: 'Could not restore the selected version.',
		noPreview: 'Text preview is unavailable for this version. You can still restore the original file.',
		noDiff: 'Text comparison is unavailable for these versions. You can still view version details and restore the file.',
		noDiffLarge: 'The line comparison exceeds the display limit. Switch to Version content to read the selected text.',
		diffLegend: '− Local content · + Selected version content',
		lineEndings: 'The files differ in their line endings or final newline.',
		local: 'Local file',
		absent: 'There is no local file at the original path.',
		same: 'The selected version matches the local file.',
		different: 'The selected version differs from the local file.',
		binarySize: 'bytes',
	},
};

const PAGE_SIZE = 50;

export class VersionHistoryModal extends Modal {
	private requestId = 0;
	private readonly labels: typeof historyText.en;
	private readonly dateFormat: Intl.DateTimeFormat;
	private readonly sizeFormat: Intl.NumberFormat;

	constructor(
		app: App,
		private readonly actions: VersionHistoryActions,
		private readonly path?: string,
	) {
		super(app);
		this.labels = historyText[actions.language];
		this.dateFormat = new Intl.DateTimeFormat(actions.language, { dateStyle: 'medium', timeStyle: 'short' });
		this.sizeFormat = new Intl.NumberFormat(actions.language);
	}

	onOpen(): void {
		if (this.path) void this.loadVersions(this.path);
		else void this.loadDeletedPaths();
	}

	onClose(): void {
		this.requestId += 1;
		this.contentEl.empty();
	}

	private async loadDeletedPaths(): Promise<void> {
		const request = ++this.requestId;
		const originalPath = this.path;
		this.renderHeader(this.labels.deleted, undefined, originalPath ? () => void this.loadVersions(originalPath) : undefined);
		const loading = this.appendStatus(this.labels.loadDeleted);
		try {
			const deleted = await this.actions.listDeletedPaths();
			if (request !== this.requestId) return;
			loading.remove();
			if (deleted.length === 0) {
				this.appendStatus(this.labels.noDeleted);
				return;
			}
			const filter = this.contentEl.createEl('input', {
				cls: 'quark-history-filter',
				attr: { type: 'search', placeholder: this.labels.filter, 'aria-label': this.labels.filter },
			});
			const results = this.contentEl.createDiv();
			const render = () => {
				const query = filter.value.trim().toLocaleLowerCase(this.actions.language);
				results.empty();
				this.appendList(results, deleted.filter((entry) => entry.path.toLocaleLowerCase(this.actions.language).includes(query)),
					(entry, list) => this.appendEntry(list, entry.path, this.formatDate(entry.deletedAt),
						() => void this.loadVersions(entry.path, true)), this.labels.noResults);
			};
			filter.addEventListener('input', render);
			render();
		} catch (error) {
			if (request === this.requestId) this.showError(loading, error, this.labels.error);
		}
	}

	private async loadVersions(path: string, fromDeleted = false): Promise<void> {
		const request = ++this.requestId;
		this.renderVersionHeader(path, fromDeleted);
		const loading = this.appendStatus(this.labels.loadHistory);
		try {
			const versions = await this.actions.listVersions(path);
			if (request !== this.requestId) return;
			loading.remove();
			this.appendVersions(versions, fromDeleted);
		} catch (error) {
			if (request === this.requestId) this.showError(loading, error, this.labels.error);
		}
	}

	private async loadPreview(event: VersionEvent, versions: VersionEvent[], fromDeleted: boolean): Promise<void> {
		const request = ++this.requestId;
		const back = () => this.renderVersions(event.path, versions, fromDeleted);
		this.renderHeader(this.labels.history, event.path, back);
		this.contentEl.createEl('p', { text: this.formatDate(event.createdAt) + ' · ' + this.versionDetails(event) });
		const loading = this.appendStatus(this.labels.loadPreview);
		try {
			const { bytes, current } = await this.actions.previewVersion(event);
			if (request !== this.requestId) return;
			loading.remove();
			this.renderPreview(event, bytes, current);
			this.renderRestore(event, current?.sha256 ?? null);
		} catch (error) {
			if (request === this.requestId) this.showError(loading, error, this.labels.error);
		}
	}

	private renderVersions(path: string, versions: VersionEvent[], fromDeleted: boolean): void {
		this.requestId += 1;
		this.renderVersionHeader(path, fromDeleted);
		this.appendVersions(versions, fromDeleted);
	}

	private renderVersionHeader(path: string, fromDeleted: boolean): void {
		this.renderHeader(this.labels.history, path, fromDeleted ? () => void this.loadDeletedPaths() : undefined);
		if (!fromDeleted) {
			this.contentEl.createEl('button', { text: this.labels.recoverDeleted })
				.addEventListener('click', () => void this.loadDeletedPaths());
		}
	}

	private appendVersions(versions: VersionEvent[], fromDeleted: boolean): void {
		this.appendList(this.contentEl, versions, (event, list) => {
			const kind = event.kind === 'file' ? this.labels.fileVersion : this.labels.deleteRecord;
			this.appendEntry(list, kind + ' · ' + this.formatDate(event.createdAt), this.versionDetails(event),
				event.kind === 'file' ? () => void this.loadPreview(event, versions, fromDeleted) : undefined);
		}, this.labels.noVersions);
	}

	private renderPreview(event: VersionEvent, bytes: Uint8Array | null, current: LocalContent | null): void {
		const selectedText = bytes ? decodeVersionText(event.path, bytes) : null;
		const localText = current ? decodeVersionText(event.path, current.bytes) : '';
		const local = current ? { size: current.bytes.byteLength, sha256: current.sha256 } : null;
		const buttons = this.contentEl.createDiv({ cls: 'quark-history-actions' });
		const preview = buttons.createEl('button', { text: this.labels.preview });
		const compare = buttons.createEl('button', { text: this.labels.diff });
		const panel = this.contentEl.createDiv();
		const show = (mode: 'preview' | 'diff') => {
			panel.empty();
			preview.setAttr('aria-pressed', mode === 'preview' ? 'true' : 'false');
			compare.setAttr('aria-pressed', mode === 'diff' ? 'true' : 'false');
			if (mode === 'preview') {
				if (selectedText === null) panel.createEl('p', { text: this.labels.noPreview });
				else panel.createEl('pre', { cls: 'quark-history-text', text: selectedText, attr: { tabindex: '0' } });
				return;
			}
			if (local) {
				panel.createEl('p', {
					text: this.labels.local + ' · ' + this.formatSize(local.size) + ' · ' + local.sha256.slice(0, 12),
				});
				panel.createEl('p', { text: local.sha256 === event.sha256 ? this.labels.same : this.labels.different });
				if (local.sha256 === event.sha256) return;
			} else {
				panel.createEl('p', { text: this.labels.absent });
			}
			if (selectedText === null || localText === null) {
				panel.createEl('p', { text: this.labels.noDiff });
				return;
			}
			const rows = buildVersionDiff(localText, selectedText);
			if (!rows) {
				panel.createEl('p', { text: this.labels.noDiffLarge });
				return;
			}
			if (localText !== selectedText && (
				localText.endsWith('\n') !== selectedText.endsWith('\n') ||
				localText.replace(/\r\n?/g, '\n') === selectedText.replace(/\r\n?/g, '\n')
			)) panel.createEl('p', { text: this.labels.lineEndings });
			if (rows.length === 0 || rows.every((line) => line.kind === 'same')) return;
			panel.createEl('p', { text: this.labels.diffLegend });
			const diff = panel.createEl('pre', { cls: 'quark-history-text', attr: { tabindex: '0' } });
			for (const line of rows) {
				const prefix = line.kind === 'add' ? '+ ' : line.kind === 'delete' ? '− ' : '  ';
				diff.createSpan({ cls: 'quark-history-line-' + line.kind, text: prefix + line.text + '\n' });
			}
		};
		preview.addEventListener('click', () => show('preview'));
		compare.addEventListener('click', () => show('diff'));
		show('preview');
	}

	private renderRestore(event: VersionEvent, expected: string | null): void {
		const request = this.requestId;
		const controls = this.contentEl.createDiv({ cls: 'quark-history-actions' });
		const copy = controls.createEl('button', { text: this.labels.copy, cls: 'mod-cta' });
		const restore = controls.createEl('button', { text: this.labels.restore });
		const confirmation = this.contentEl.createDiv();
		const status = this.appendStatus('');
		const run = async (mode: VersionRestoreMode) => {
			confirmation.empty();
			copy.disabled = true;
			restore.disabled = true;
			status.setAttr('role', 'status');
			status.setText(this.labels.restorePending);
			try {
				const path = await this.actions.restoreVersion(event, mode, expected);
				new Notice(this.labels.restored + path);
				if (request === this.requestId) this.close();
			} catch (error) {
				if (request === this.requestId) this.showError(status, error, this.labels.restoreError);
			} finally {
				copy.disabled = false;
				restore.disabled = expected === event.sha256;
			}
		};
		copy.addEventListener('click', () => void run('copy'));
		restore.disabled = expected === event.sha256;
		restore.addEventListener('click', () => {
			confirmation.empty();
			confirmation.createEl('p', { text: expected === null ? this.labels.confirmCreate : this.labels.confirmOverwrite });
			const buttons = confirmation.createDiv({ cls: 'quark-history-actions' });
			buttons.createEl('button', { text: this.labels.cancel }).addEventListener('click', () => confirmation.empty());
			buttons.createEl('button', { text: this.labels.confirm, cls: 'mod-warning' })
				.addEventListener('click', () => void run('current'));
		});
	}

	private renderHeader(title: string, path?: string, back?: () => void): void {
		this.contentEl.empty();
		this.setTitle(title);
		const buttons = this.contentEl.createDiv({ cls: 'quark-history-actions' });
		if (back) buttons.createEl('button', { text: this.labels.back }).addEventListener('click', back);
		buttons.createEl('button', { text: this.labels.close }).addEventListener('click', () => this.close());
		if (path) this.contentEl.createEl('h3', { cls: 'quark-history-path', text: path });
	}

	private appendList<T>(
		container: HTMLElement,
		items: T[],
		add: (item: T, list: HTMLUListElement) => void,
		empty: string,
	): void {
		if (items.length === 0) {
			container.createEl('p', { text: empty });
			return;
		}
		const list = container.createEl('ul', { cls: 'quark-history-list' });
		const more = container.createEl('button', { text: this.labels.loadMore });
		let shown = 0;
		const showPage = () => {
			const end = Math.min(shown + PAGE_SIZE, items.length);
			for (; shown < end; shown += 1) add(items[shown], list);
			more.hidden = shown >= items.length;
		};
		more.addEventListener('click', showPage);
		showPage();
	}

	private appendEntry(list: HTMLUListElement, name: string, detail: string, action?: () => void): void {
		const item = list.createEl('li');
		if (action) item.createEl('button', { text: name }).addEventListener('click', action);
		else item.createEl('strong', { text: name });
		item.createDiv({ cls: 'quark-history-detail', text: detail });
	}

	private appendStatus(text: string): HTMLParagraphElement {
		return this.contentEl.createEl('p', { text, attr: { role: 'status' } });
	}

	private showError(element: HTMLElement, error: unknown, fallback: string): void {
		element.setAttr('role', 'alert');
		element.setText(error instanceof Error && error.message ? error.message : fallback);
	}

	private formatDate(timestamp: number): string {
		return Number.isFinite(new Date(timestamp).getTime()) ? this.dateFormat.format(timestamp) : String(timestamp);
	}

	private formatSize(size: number): string {
		return this.sizeFormat.format(size) + ' ' + this.labels.binarySize;
	}

	private versionDetails(event: VersionEvent): string {
		return [
			event.deviceId,
			event.id.slice(0, 12),
			...(event.size === undefined ? [] : [this.formatSize(event.size)]),
		].join(' · ');
	}
}
