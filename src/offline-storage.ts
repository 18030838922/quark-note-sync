import { Modal, Setting, type App } from 'obsidian';

export interface OfflineStorageEntry {
	path: string;
	size: number;
	kind: 'attachment' | 'quark';
	local: boolean;
	pinned: boolean;
	lastOpened?: number;
	notes: readonly string[];
}

export interface OfflineStorageActions {
	language: 'zh-CN' | 'en';
	enabled(): boolean;
	setEnabled(enabled: boolean): Promise<boolean>;
	list(): Promise<OfflineStorageEntry[]>;
	open(entry: OfflineStorageEntry): Promise<void>;
	get(entry: OfflineStorageEntry, pin: boolean): Promise<void>;
	pin(entry: OfflineStorageEntry, pinned: boolean): Promise<void>;
	remove(entry: OfflineStorageEntry): Promise<void>;
}

export class OfflineStorageModal extends Modal {
	private rows: OfflineStorageEntry[] = [];
	private generation = 0;
	private filter = '';
	private removePath: string | undefined;

	constructor(app: App, private readonly actions: OfflineStorageActions) { super(app); }

	onOpen(): void {
		this.setTitle(this.label('按需附件与离线空间', 'On-demand attachments and offline storage'));
		void this.refresh();
	}

	onClose(): void {
		this.generation += 1;
		this.contentEl.empty();
	}

	private async refresh(): Promise<void> {
		const generation = ++this.generation;
		this.contentEl.empty();
		this.contentEl.createEl('p', { text: this.label('正在统计离线文件…', 'Loading offline files…') });
		try {
			const rows = await this.actions.list();
			if (generation !== this.generation) return;
			this.rows = rows;
			this.render();
		} catch {
			if (generation === this.generation) this.contentEl.setText(this.label('暂时无法读取离线文件。', 'Offline files are unavailable.'));
		}
	}

	private render(): void {
		const container = this.contentEl;
		container.empty();
		new Setting(container).setName(this.label('附件按需下载', 'Download attachments on demand'))
			.setDesc(this.label('远端独有的附件只记录文件信息，点开时下载。已有本地文件继续正常同步。',
				'Cloud-only attachments are listed by name and downloaded on request. Existing local files keep syncing normally.'))
			.addToggle((toggle) => toggle.setValue(this.actions.enabled()).onChange(async (enabled) => {
				toggle.setDisabled(true);
				await this.actions.setEnabled(enabled);
				if (container.isConnected) toggle.setValue(this.actions.enabled()).setDisabled(false);
			}));
		const totals = this.rows.filter((row) => row.local).reduce((total, row) => total + row.size, 0);
		container.createEl('p', { text: this.label(`本地副本占用 ${this.size(totals)}`, `Local copies use ${this.size(totals)}`) });
		const search = container.createEl('input', { attr: { type: 'search', placeholder: this.label('按文件名查找', 'Find a file'), 'aria-label': this.label('查找离线文件', 'Find offline files') } });
		search.value = this.filter;
		const results = container.createDiv();
		search.addEventListener('input', () => {
			this.filter = search.value;
			this.renderRows(results);
		});
		this.renderRows(results);
	}

	private renderRows(container: HTMLElement): void {
		container.empty();
		const rows = this.rows.filter((entry) => entry.path.toLowerCase().includes(this.filter.trim().toLowerCase()));
		if (!rows.length) {
			container.createEl('p', { text: this.label('还没有按需附件或离线副本。', 'No on-demand attachments or offline copies yet.') });
			return;
		}
		for (const row of rows.slice(0, 150)) {
			const entry = container.createDiv({ cls: 'quark-offline-file' });
			entry.createEl('strong', { text: row.path });
			const status = row.local ? this.label('有本地副本', 'Local copy') : this.label('仅云端', 'Cloud only');
			const kind = row.kind === 'quark' ? this.label('网盘引用副本', 'Drive reference copy') : this.label('同步附件', 'Synced attachment');
			const accessed = row.lastOpened ? new Date(row.lastOpened).toLocaleString(this.actions.language) : this.label('无记录', 'No record');
			entry.createEl('p', { text: `${kind} · ${this.size(row.size)} · ${status} · ${this.label('最近打开', 'Last opened')} ${accessed}` });
			if (row.notes.length) {
				const links = entry.createEl('details');
				links.createEl('summary', { text: this.label(`关联笔记（${row.notes.length}）`, `Linked notes (${row.notes.length})`) });
				const list = links.createEl('ul');
				for (const note of row.notes) list.createEl('li', { text: note });
			}
			const buttons = entry.createDiv({ cls: 'quark-history-actions' });
			const run = (task: () => Promise<void>) => {
				const generation = this.generation;
				for (const control of buttons.querySelectorAll('button')) control.disabled = true;
				void task().finally(() => {
					if (generation === this.generation) void this.refresh();
				});
			};
			if (row.local) this.button(buttons, this.label('打开', 'Open'), () => run(() => this.actions.open(row)));
			if (!row.local && row.kind === 'attachment') {
				this.button(buttons, this.label('下载', 'Download'), () => run(() => this.actions.get(row, false)));
			}
			if (row.kind === 'attachment') {
				const pin = row.pinned ? this.label('取消离线保留', 'Unpin offline') : this.label('始终离线可用', 'Keep offline');
				this.button(buttons, pin, () => run(() => row.local || row.pinned ? this.actions.pin(row, !row.pinned) : this.actions.get(row, true)));
			}
			if (row.local && (row.kind === 'quark' || this.actions.enabled())) {
				const requested = this.removePath === row.path;
				if (requested) entry.createEl('p', { text: this.label(
					'移除这个本地副本？云端原件和笔记里的链接会保留。',
					'Remove this local copy? The cloud file and links in notes will remain.'),
				});
				this.button(buttons, requested ? this.label('确认移除', 'Confirm removal') : this.label('移除本地副本', 'Remove local copy'), () => {
					if (requested) {
						this.removePath = undefined;
						run(() => this.actions.remove(row));
					} else {
						this.removePath = row.path;
						this.renderRows(container);
					}
				});
				if (requested) this.button(buttons, this.label('取消', 'Cancel'), () => {
					this.removePath = undefined;
					this.renderRows(container);
				});
			}
		}
		if (rows.length > 150) container.createEl('p', { text: this.label('只显示前 150 个匹配项，可缩小查找范围。', 'Showing the first 150 matches. Refine the search to see more.') });
	}

	private button(container: HTMLElement, text: string, click: () => void): void {
		container.createEl('button', { text, attr: { type: 'button' } }).addEventListener('click', click);
	}

	private size(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		const power = Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024)));
		return `${(bytes / 1024 ** power).toFixed(1)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][power]}`;
	}

	private label(chinese: string, english: string): string { return this.actions.language === 'en' ? english : chinese; }
}
