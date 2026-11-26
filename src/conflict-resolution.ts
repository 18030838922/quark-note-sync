import { Modal, Notice, type App } from 'obsidian';
import type { VersionEvent } from './core.ts';
import {
	buildConflictMerge,
	composeConflictMerge,
	type ConflictPreview,
	type ConflictResolutionChoice,
	type ConflictResolutionRequest,
	type MergeSide,
	type SyncConflict,
} from './conflict-resolution-model.ts';
import type { Language } from './settings-text.ts';
import { decodeVersionText } from './version-history-model.ts';

export type { ConflictPreview, ConflictResolutionRequest, SyncConflict } from './conflict-resolution-model.ts';

export interface ConflictResolutionActions {
	language: Language;
	listConflicts(): Promise<SyncConflict[]>;
	previewConflict(path: string, cloudVersionId: string): Promise<ConflictPreview>;
	applyResolution(request: ConflictResolutionRequest): Promise<void>;
}

const conflictText = {
	'zh-CN': {
		title: '同步冲突',
		loading: '正在查找同步冲突…',
		noConflicts: '没有待处理的同步冲突。',
		noPathConflict: '此文件没有待处理的同步冲突。',
		search: '搜索笔记路径',
		noResults: '没有匹配的笔记。',
		loadingPreview: '正在读取本地和云端版本…',
		loadError: '读取同步冲突失败。',
		local: '本地版本',
		cloud: '云端版本',
		cloudPicker: '选择要比较的云端版本',
		deleted: '已删除',
		empty: '空文件',
		emptySection: '空段',
		unavailable: '文本预览不可用。可以选择同步整个版本。',
		bytes: '字节',
		reload: '重新读取',
		back: '返回冲突列表',
		keepLocal: '保留本地',
		keepCloud: '采用云端',
		keepLocalDeletion: '保留本地删除',
		keepCloudDeletion: '采用云端删除',
		merge: '分段合并',
		noMerge: '此文件无法分段合并。请选择整个本地或云端版本。',
		threeWay: '两侧独立的修改已纳入合并。请选择每处重叠差异要保留的内容。',
		twoWay: '未找到可用于比较的共同祖先。请选择每段差异要保留的内容。',
		section: (index: number) => `差异段 ${index}`,
		lineEnding: '两侧的换行格式或末尾换行不同。',
		mergePreview: '合并结果',
		selectSections: (count: number) => `还有 ${count} 段差异待选择。`,
		useMerge: '采用合并结果',
		confirmWrite: '将所选内容保存到此路径并同步到夸克网盘。原有云端版本可从版本历史查看。',
		confirmDelete: '将同步此路径的删除。原有云端版本可从版本历史恢复。',
		confirmBranches: '确认后，此文件的所有冲突分支都将结束，包括其他云端版本。可以返回并切换云端版本逐一查看。',
		cancel: '取消',
		sync: '确认并同步',
		syncing: '正在保存并同步…',
		syncError: '无法同步处理结果。',
		synced: '已处理并同步 ',
		more: '加载更多',
	},
	en: {
		title: 'Sync conflicts',
		loading: 'Finding sync conflicts…',
		noConflicts: 'There are no unresolved sync conflicts.',
		noPathConflict: 'This file has no unresolved sync conflicts.',
		search: 'Search note paths',
		noResults: 'No matching notes.',
		loadingPreview: 'Loading local and cloud versions…',
		loadError: 'Could not load sync conflicts.',
		local: 'Local version',
		cloud: 'Cloud version',
		cloudPicker: 'Cloud version to compare',
		deleted: 'Deleted',
		empty: 'Empty file',
		emptySection: 'Empty section',
		unavailable: 'Text preview is unavailable. You can still sync the entire version.',
		bytes: 'bytes',
		reload: 'Reload',
		back: 'Back to conflicts',
		keepLocal: 'Keep local',
		keepCloud: 'Use cloud',
		keepLocalDeletion: 'Keep local deletion',
		keepCloudDeletion: 'Use cloud deletion',
		merge: 'Merge by section',
		noMerge: 'Section merging is unavailable for this file. Choose the entire local or cloud version.',
		threeWay: 'Independent changes from both sides are included. Choose what to keep for each overlapping change.',
		twoWay: 'A common ancestor could not be used for comparison. Choose what to keep in each changed section.',
		section: (index: number) => `Changed section ${index}`,
		lineEnding: 'The versions differ in line endings or their final newline.',
		mergePreview: 'Merged result',
		selectSections: (count: number) => `Sections still to choose: ${count}.`,
		useMerge: 'Use merged result',
		confirmWrite: 'The chosen content will be saved at this path and synced to Quark. Earlier cloud versions remain available in version history.',
		confirmDelete: 'The deletion at this path will be synced. Earlier cloud versions can be recovered from version history.',
		confirmBranches: 'Confirming resolves all competing branches for this file, including other cloud versions. You can go back and select each cloud version to review it.',
		cancel: 'Cancel',
		sync: 'Confirm and sync',
		syncing: 'Saving and syncing…',
		syncError: 'Could not sync the resolution.',
		synced: 'Resolved and synced ',
		more: 'Load more',
	},
};

const PAGE_SIZE = 30;

export class ConflictResolutionModal extends Modal {
	private requestId = 0;
	private readonly labels: typeof conflictText.en;
	private readonly dateFormat: Intl.DateTimeFormat;
	private readonly sizeFormat: Intl.NumberFormat;

	constructor(app: App, private readonly actions: ConflictResolutionActions, private readonly path?: string) {
		super(app);
		this.labels = conflictText[actions.language];
		this.dateFormat = new Intl.DateTimeFormat(actions.language, { dateStyle: 'medium', timeStyle: 'short' });
		this.sizeFormat = new Intl.NumberFormat(actions.language);
	}

	onOpen(): void {
		this.modalEl.addClass('quark-conflict-modal');
		this.setTitle(this.labels.title);
		void this.loadConflicts(this.path);
	}

	onClose(): void {
		this.requestId += 1;
		this.contentEl.empty();
	}

	private async loadConflicts(path?: string): Promise<void> {
		const request = ++this.requestId;
		this.contentEl.empty();
		const status = this.status(this.contentEl, this.labels.loading);
		try {
			const conflicts = (await this.actions.listConflicts()).filter((entry) => entry.cloudVersions.length > 0);
			if (request !== this.requestId) return;
			status.remove();
			const selected = conflicts.find((entry) => entry.path === path);
			if (selected) this.showConflict(selected);
			else this.showList(conflicts, path);
		} catch (error) {
			if (request !== this.requestId) return;
			this.showError(status, error, this.labels.loadError);
			this.contentEl.createEl('button', { text: this.labels.reload })
				.addEventListener('click', () => void this.loadConflicts(path));
		}
	}

	private showList(conflicts: SyncConflict[], path?: string): void {
		if (path && conflicts.length > 0) this.status(this.contentEl, this.labels.noPathConflict);
		if (conflicts.length === 0) {
			this.status(this.contentEl, path ? this.labels.noPathConflict : this.labels.noConflicts);
			this.contentEl.createEl('button', { text: this.labels.reload })
				.addEventListener('click', () => void this.loadConflicts(path));
			return;
		}
		const filter = this.contentEl.createEl('input', {
			cls: 'quark-history-filter',
			attr: { type: 'search', placeholder: this.labels.search, 'aria-label': this.labels.search },
		});
		const results = this.contentEl.createDiv();
		const show = () => {
			const query = filter.value.trim().toLocaleLowerCase(this.actions.language);
			const matching = conflicts.filter((entry) => entry.path.toLocaleLowerCase(this.actions.language).includes(query));
			results.empty();
			if (matching.length === 0) {
				this.status(results, this.labels.noResults);
				return;
			}
			const list = results.createEl('ul', { cls: 'quark-history-list' });
			const more = results.createEl('button', { text: this.labels.more });
			let shown = 0;
			const page = () => {
				const end = Math.min(shown + PAGE_SIZE, matching.length);
				for (; shown < end; shown += 1) {
					const conflict = matching[shown];
					list.createEl('li').createEl('button', { text: conflict.path })
						.addEventListener('click', () => this.showConflict(conflict));
				}
				more.hidden = shown >= matching.length;
			};
			more.addEventListener('click', page);
			page();
		};
		filter.addEventListener('input', show);
		show();
	}

	private showConflict(conflict: SyncConflict): void {
		this.contentEl.empty();
		const controls = this.controls(this.contentEl);
		controls.createEl('button', { text: this.labels.back }).addEventListener('click', () => void this.loadConflicts());
		controls.createEl('button', { text: this.labels.reload }).addEventListener('click', () => void this.loadConflicts(conflict.path));
		this.contentEl.createEl('h3', { cls: 'quark-history-path', text: conflict.path });
		const first = conflict.cloudVersions[0];
		const picker = this.renderCloudPicker(conflict);
		const panel = this.contentEl.createDiv();
		picker?.addEventListener('change', () => void this.loadPreview(panel, conflict, picker.value, picker));
		void this.loadPreview(panel, conflict, first.id, picker);
	}

	private renderCloudPicker(conflict: SyncConflict): HTMLSelectElement | undefined {
		if (conflict.cloudVersions.length < 2) return;
		const label = this.contentEl.createEl('label', { cls: 'quark-conflict-controls' });
		label.createSpan({ text: this.labels.cloudPicker });
		const picker = label.createEl('select', { cls: 'quark-conflict-picker' });
		for (const event of conflict.cloudVersions) {
			picker.createEl('option', { value: event.id, text: this.cloudDetails(event) });
		}
		return picker;
	}

	private async loadPreview(
		panel: HTMLElement,
		conflict: SyncConflict,
		cloudId: string,
		picker?: HTMLSelectElement,
	): Promise<void> {
		const request = ++this.requestId;
		panel.empty();
		const status = this.status(panel, this.labels.loadingPreview);
		if (picker) picker.disabled = true;
		try {
			const preview = await this.actions.previewConflict(conflict.path, cloudId);
			if (request !== this.requestId) return;
			this.renderPreview(panel, conflict, preview, request);
			status.remove();
		} catch (error) {
			if (request === this.requestId) this.showError(status, error, this.labels.loadError);
		} finally {
			if (picker) picker.disabled = false;
		}
	}

	private renderPreview(panel: HTMLElement, conflict: SyncConflict, preview: ConflictPreview, request: number): void {
		const cloud = preview.cloudVersion;
		const local = preview.localBytes ? decodeVersionText(preview.path, preview.localBytes) : null;
		const remote = preview.cloudBytes ? decodeVersionText(preview.path, preview.cloudBytes) : null;
		const columns = panel.createDiv({ cls: 'quark-conflict-columns' });
		this.versionColumn(columns, this.labels.local, local, preview.localHash === null,
			this.localDetails(preview));
		this.versionColumn(columns, this.labels.cloud, remote, cloud.kind === 'delete',
			this.cloudDetails(cloud));
		const options = this.controls(panel);
		const localAction = options.createEl('button', {
			text: preview.localHash === null ? this.labels.keepLocalDeletion : this.labels.keepLocal,
		});
		const cloudAction = options.createEl('button', {
			text: cloud.kind === 'delete' ? this.labels.keepCloudDeletion : this.labels.keepCloud,
		});
		const confirmation = panel.createDiv();
		const merge = panel.createDiv();
		const confirm = (choice: ConflictResolutionChoice, label: string) => {
			confirmation.empty();
			const deleting = choice.kind === 'local' ? preview.localHash === null
				: choice.kind === 'cloud' && cloud.kind === 'delete';
			confirmation.createEl('strong', { text: label });
			confirmation.createEl('p', { text: deleting ? this.labels.confirmDelete : this.labels.confirmWrite });
			if (conflict.cloudVersions.length > 1 || preview.headIds.length > 2) {
				confirmation.createEl('p', { text: this.labels.confirmBranches });
			}
			const buttons = this.controls(confirmation);
			const cancel = buttons.createEl('button', { text: this.labels.cancel });
			cancel.addEventListener('click', () => confirmation.empty());
			const sync = buttons.createEl('button', { cls: deleting ? 'mod-warning' : 'mod-cta', text: this.labels.sync });
			const status = this.status(confirmation, '');
			sync.addEventListener('click', () => void this.apply(preview, choice, request, status));
			cancel.focus();
			confirmation.scrollIntoView({ block: 'nearest' });
		};
		localAction.addEventListener('click', () => confirm({ kind: 'local' }, localAction.textContent ?? this.labels.keepLocal));
		cloudAction.addEventListener('click', () => confirm({ kind: 'cloud' }, cloudAction.textContent ?? this.labels.keepCloud));
		const mergeAction = options.createEl('button', { text: this.labels.merge, attr: { 'aria-expanded': 'false' } });
		mergeAction.addEventListener('click', () => {
			confirmation.empty();
			if (merge.childElementCount > 0) {
				merge.empty();
				mergeAction.setAttr('aria-expanded', 'false');
				return;
			}
			mergeAction.setAttr('aria-expanded', 'true');
			const base = preview.baseBytes ? decodeVersionText(preview.path, preview.baseBytes) : null;
			this.renderMerge(merge, local, remote, base, confirmation, confirm);
		});
	}

	private renderMerge(
		container: HTMLElement,
		local: string | null,
		cloud: string | null,
		base: string | null,
		confirmation: HTMLElement,
		confirm: (choice: ConflictResolutionChoice, label: string) => void,
	): void {
		const sections = local === null || cloud === null ? null : buildConflictMerge(local, cloud, base);
		if (!sections) {
			this.status(container, this.labels.noMerge);
			return;
		}
		const unresolved = sections.filter((section) => section.kind === 'choice');
		if (unresolved.length > 0) {
			container.createEl('p', { text: base === null ? this.labels.twoWay : this.labels.threeWay });
		}
		const options = container.createDiv();
		const more = container.createEl('button', { text: this.labels.more });
		const status = this.status(container, '');
		const details = container.createEl('details');
		details.open = true;
		details.createEl('summary', { text: this.labels.mergePreview });
		const merged = details.createEl('pre', { cls: 'quark-history-text', attr: { tabindex: '0' } });
		const button = this.controls(container).createEl('button', { cls: 'mod-cta', text: this.labels.useMerge });
		const choices = new Array<MergeSide | undefined>(unresolved.length);
		let result: string | null = null;
		const update = () => {
			const remaining = unresolved.length - choices.filter((choice) => choice !== undefined).length;
			result = composeConflictMerge(sections, choices);
			status.setText(remaining ? this.labels.selectSections(remaining) : '');
			details.hidden = result === null;
			merged.setText(result === '' ? this.labels.empty : result ?? '');
			button.disabled = result === null;
		};
		let shown = 0;
		const page = () => {
			const end = Math.min(shown + PAGE_SIZE, unresolved.length);
			for (; shown < end; shown += 1) {
				const index = shown;
				const section = unresolved[index];
				const field = options.createEl('fieldset', { cls: 'quark-conflict-choice' });
				field.createEl('legend', { text: this.labels.section(index + 1) });
				const columns = field.createDiv({ cls: 'quark-conflict-columns' });
				const localColumn = this.sectionColumn(columns, this.labels.keepLocal, section.local);
				const cloudColumn = this.sectionColumn(columns, this.labels.keepCloud, section.cloud);
				const select = (side: MergeSide) => {
					choices[index] = side;
					localColumn.setAttr('aria-pressed', String(side === 'local'));
					cloudColumn.setAttr('aria-pressed', String(side === 'cloud'));
					confirmation.empty();
					update();
				};
				localColumn.addEventListener('click', () => select('local'));
				cloudColumn.addEventListener('click', () => select('cloud'));
				if (differOnlyInLineBreaks(section.local, section.cloud)) {
					field.createEl('p', { cls: 'quark-conflict-meta', text: this.labels.lineEnding });
				}
			}
			more.hidden = shown >= unresolved.length;
		};
		more.addEventListener('click', page);
		page();
		update();
		button.addEventListener('click', () => {
			if (result !== null) confirm({ kind: 'merged', bytes: new TextEncoder().encode(result) }, this.labels.useMerge);
		});
	}

	private versionColumn(
		parent: HTMLElement,
		label: string,
		text: string | null,
		deleted: boolean,
		details: string,
	): void {
		const column = parent.createDiv({ cls: 'quark-conflict-column' });
		column.createEl('h4', { text: label });
		if (details) column.createDiv({ cls: 'quark-conflict-meta', text: details });
		if (deleted || text === null) this.status(column, deleted ? this.labels.deleted : this.labels.unavailable);
		else column.createEl('pre', { cls: 'quark-history-text', text: text || this.labels.empty, attr: { tabindex: '0' } });
	}

	private sectionColumn(parent: HTMLElement, label: string, content: string): HTMLButtonElement {
		const column = parent.createDiv({ cls: 'quark-conflict-column' });
		column.createEl('pre', { cls: 'quark-history-text', text: content || this.labels.emptySection, attr: { tabindex: '0' } });
		return this.controls(column).createEl('button', { text: label, attr: { 'aria-pressed': 'false' } });
	}

	private async apply(
		preview: ConflictPreview,
		choice: ConflictResolutionChoice,
		request: number,
		status: HTMLElement,
	): Promise<void> {
		const controls = [...this.contentEl.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>(
			'button:not(:disabled), input:not(:disabled), select:not(:disabled)',
		)];
		for (const control of controls) control.disabled = true;
		status.setAttr('role', 'status');
		status.setText(this.labels.syncing);
		try {
			await this.actions.applyResolution({
				path: preview.path,
				expectedHeadIds: preview.headIds,
				expectedLocalHash: preview.localHash,
				cloudVersionId: preview.cloudVersion.id,
				choice,
			});
			new Notice(this.labels.synced + preview.path);
			if (request !== this.requestId) return;
			if (this.path) this.close();
			else void this.loadConflicts();
		} catch (error) {
			if (request === this.requestId) this.showError(status, error, this.labels.syncError);
		} finally {
			for (const control of controls) control.disabled = false;
		}
	}

	private localDetails(preview: ConflictPreview): string {
		if (preview.localHash === null) return '';
		const size = preview.localSize ?? preview.localBytes?.byteLength;
		return [size === undefined ? '' : this.formatSize(size), preview.localHash.slice(0, 12)].filter(Boolean).join(' · ');
	}

	private cloudDetails(event: VersionEvent): string {
		const date = new Date(event.createdAt);
		return [
			Number.isFinite(date.getTime()) ? this.dateFormat.format(date) : String(event.createdAt),
			event.deviceId,
			event.id.slice(0, 12),
			event.kind === 'delete' ? this.labels.deleted : event.size === undefined ? '' : this.formatSize(event.size),
		].filter(Boolean).join(' · ');
	}

	private formatSize(bytes: number): string {
		return this.sizeFormat.format(bytes) + ' ' + this.labels.bytes;
	}

	private controls(parent: HTMLElement): HTMLDivElement {
		return parent.createDiv({ cls: 'quark-history-actions quark-conflict-controls' });
	}

	private status(parent: HTMLElement, text: string): HTMLParagraphElement {
		return parent.createEl('p', { text, attr: { role: 'status' } });
	}

	private showError(element: HTMLElement, error: unknown, fallback: string): void {
		element.setAttr('role', 'alert');
		element.setText(error instanceof Error && error.message ? error.message : fallback);
	}
}

function differOnlyInLineBreaks(local: string, cloud: string): boolean {
	const normalize = (text: string) => text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
	return local !== cloud && normalize(local) === normalize(cloud);
}
