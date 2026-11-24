import { ItemView, Notice, type WorkspaceLeaf } from 'obsidian';
import type { RemoteFile } from './quark-api.ts';
import { parseOfficialShareUrl, previewKindForFile, type PreviewKind } from './quark-references.ts';

export const QUARK_PREVIEW_VIEW_TYPE = 'quark-note-sync-preview';
export const QUARK_BROWSER_VIEW_TYPE = 'quark-note-sync-browser';

export interface ShareSessionLike {
	pwdId: string;
	stoken: string;
}

export interface ShareEntryLike extends RemoteFile {
	fidToken: string;
}

export interface SourceEditorTarget {
	insert(markdown: string): boolean;
}

export interface PreviewPayload {
	name: string;
	kind: PreviewKind;
	bytes?: Uint8Array;
	mimeType?: string;
	text?: string;
	message?: string;
	officialUrl?: string;
	download?: () => Promise<void>;
}

export interface QuarkBrowserActions {
	language: 'zh-CN' | 'en';
	listPersonal(parentFid: string): Promise<RemoteFile[]>;
	openShare(pwdId: string, passcode: string): Promise<ShareSessionLike>;
	listShare(session: ShareSessionLike, parentFid: string): Promise<ShareEntryLike[]>;
	previewPersonal(file: RemoteFile, parentFid: string, target?: SourceEditorTarget): Promise<void>;
	downloadPersonal(file: RemoteFile, parentFid: string, target?: SourceEditorTarget): Promise<void>;
	insertReference(file: RemoteFile, parentFid: string, target?: SourceEditorTarget): Promise<void>;
	insertShareReference(session: ShareSessionLike, file: ShareEntryLike, parentFid: string, target?: SourceEditorTarget): Promise<void>;
	previewShare(session: ShareSessionLike, file: ShareEntryLike, officialUrl: string): Promise<void>;
	downloadShare(session: ShareSessionLike, file: ShareEntryLike, parentFid: string, target?: SourceEditorTarget): Promise<void>;
	openOfficialShare(url: string): void;
}

interface DirectoryCrumb {
	fid: string;
	name: string;
}

export class QuarkBrowserView extends ItemView {
	private readonly actions: QuarkBrowserActions;
	private mode: 'personal' | 'share' = 'personal';
	private shareSession: ShareSessionLike | undefined;
	private officialShareUrl: string | undefined;
	private passcodeRequired = false;
	private crumbs: DirectoryCrumb[] = [{ fid: '0', name: '夸克网盘' }];
	private entries: Array<RemoteFile | ShareEntryLike> = [];
	private error = '';
	private loading = false;
	private requestId = 0;
	private insertionTarget: SourceEditorTarget | undefined;

	constructor(
		leaf: WorkspaceLeaf,
		actions: QuarkBrowserActions,
	) {
		super(leaf);
		this.actions = actions;
		this.containerEl.addClass('quark-browser-view');
	}

	getViewType(): string {
		return QUARK_BROWSER_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.mode === 'share' ? 'Quark share' : 'Quark Drive';
	}

	getState(): Record<string, unknown> {
		return this.mode === 'share' ? { mode: 'share' } : { mode: 'personal', parentFid: this.crumbs[this.crumbs.length - 1].fid };
	}

	async setState(state: Record<string, unknown>): Promise<void> {
		this.requestId += 1;
		this.entries = [];
		this.shareSession = undefined;
		this.officialShareUrl = undefined;
		this.passcodeRequired = false;
		if (state.mode === 'share') {
			this.mode = 'share';
			this.error = this.label('分享会话仅在当前运行期间保留。请粘贴官方分享链接以重新读取。', 'Share sessions stay in memory only. Paste the official share link to reopen it.');
			this.loading = false;
			this.crumbs = [{ fid: '0', name: this.label('分享文件', 'Shared files') }];
			this.render();
			return;
		}
		this.mode = 'personal';
		await this.loadPersonal('0', [{ fid: '0', name: this.label('夸克网盘', 'Quark Drive') }]);
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass('quark-browser-view-content');
		this.render();
	}

	async onClose(): Promise<void> {
		this.requestId += 1;
		this.shareSession = undefined;
		this.officialShareUrl = undefined;
	}

	clearSensitiveState(): void {
		this.requestId += 1;
		this.shareSession = undefined;
		this.officialShareUrl = undefined;
		this.entries = [];
	}

	setInsertionTarget(target?: SourceEditorTarget): void {
		this.insertionTarget = target;
	}

	async openShareUrl(rawUrl: string): Promise<void> {
		const parsed = parseOfficialShareUrl(rawUrl);
		const requestId = ++this.requestId;
		if (!parsed) {
			this.error = this.label('只支持 pan.quark.cn 官方分享链接。', 'Only official pan.quark.cn share links are supported.');
			this.mode = 'share';
			this.render();
			return;
		}
		this.mode = 'share';
		this.shareSession = undefined;
		this.officialShareUrl = parsed.officialUrl;
		this.passcodeRequired = false;
		this.loading = true;
		this.error = '';
		this.render();
		try {
			const session = await this.actions.openShare(parsed.pwdId, parsed.passcode);
			if (requestId !== this.requestId) return;
			this.shareSession = session;
			await this.loadOpenedShare(parsed, session);
		} catch (error) {
			if (requestId !== this.requestId) return;
			this.loading = false;
			this.passcodeRequired = isPasscodeError(error);
			this.error = this.passcodeRequired
				? this.label('此分享需要提取码。', 'This share requires a passcode.')
				: error instanceof Error ? error.message : this.label('无法读取分享内容。', 'Could not read this share.');
			this.render();
		}
	}

	private async submitShareUrl(input: HTMLInputElement): Promise<void> {
		const value = input.value.trim();
		input.value = '';
		await this.openShareUrl(value);
	}

	private async submitPasscode(input: HTMLInputElement): Promise<void> {
		const rawUrl = this.officialShareUrl;
		if (!rawUrl) return;
		const parsed = parseOfficialShareUrl(rawUrl);
		if (!parsed) return;
		const passcode = input.value;
		input.value = '';
		const requestId = ++this.requestId;
		this.loading = true;
		this.error = '';
		this.render();
		try {
			const session = await this.actions.openShare(parsed.pwdId, passcode);
			if (requestId !== this.requestId) return;
			this.shareSession = session;
			this.passcodeRequired = false;
			await this.loadOpenedShare(parsed, session);
		} catch (error) {
			if (requestId !== this.requestId) return;
			this.loading = false;
			this.passcodeRequired = isPasscodeError(error);
			this.error = this.passcodeRequired
				? this.label('提取码无效，请重试。', 'That passcode was not accepted. Try again.')
				: error instanceof Error ? error.message : this.label('无法读取分享内容。', 'Could not read this share.');
			this.render();
		}
	}

	private async loadOpenedShare(parsed: NonNullable<ReturnType<typeof parseOfficialShareUrl>>, session: ShareSessionLike): Promise<void> {
		const selectedParent = parsed.selectedParentFid ?? '0';
		const crumbs = selectedParent === '0'
			? [{ fid: '0', name: this.label('分享文件', 'Shared files') }]
			: [
				{ fid: '0', name: this.label('分享文件', 'Shared files') },
				{ fid: selectedParent, name: this.label('分享文件夹', 'Shared folder') },
			];
		await this.loadShare(selectedParent, crumbs);
		if (this.shareSession !== session || this.officialShareUrl !== parsed.officialUrl) return;
		if (parsed.selectedFid) {
			const selected = this.entries.find((entry) => entry.fid === parsed.selectedFid);
			if (selected && !selected.isDirectory) this.openShareFile(selected as ShareEntryLike);
		}
	}

	private async loadPersonal(fid: string, crumbs: DirectoryCrumb[]): Promise<void> {
		const requestId = ++this.requestId;
		this.mode = 'personal';
		this.crumbs = crumbs;
		this.loading = true;
		this.error = '';
		this.render();
		try {
			const entries = await this.actions.listPersonal(fid);
			if (requestId !== this.requestId) return;
			this.entries = entries;
		} catch (error) {
			if (requestId !== this.requestId) return;
			this.entries = [];
			this.error = error instanceof Error ? error.message : this.label('无法读取夸克目录。', 'Could not load this Quark folder.');
		}
		this.loading = false;
		this.render();
	}

	private async loadShare(fid: string, crumbs: DirectoryCrumb[]): Promise<void> {
		if (!this.shareSession) return;
		const requestId = ++this.requestId;
		this.mode = 'share';
		this.crumbs = crumbs;
		this.loading = true;
		this.error = '';
		this.render();
		try {
			const entries = await this.actions.listShare(this.shareSession, fid);
			if (requestId !== this.requestId) return;
			this.entries = entries;
		} catch (error) {
			if (requestId !== this.requestId) return;
			this.entries = [];
			this.error = error instanceof Error ? error.message : this.label('无法读取分享目录。', 'Could not load this shared folder.');
		}
		this.loading = false;
		this.render();
	}

	private render(): void {
		this.contentEl.empty();
		const title = this.mode === 'share'
			? this.label('夸克公开分享（只读）', 'Quark public share (read only)')
			: this.label('浏览夸克网盘', 'Browse Quark Drive');
		this.contentEl.createEl('p', { cls: 'quark-browser-title', text: title });
		const toolbar = this.contentEl.createDiv({ cls: 'quark-browser-toolbar' });
		this.addButton(toolbar, this.label('返回上级', 'Up one level'), () => {
			if (this.crumbs.length <= 1) return;
			const next = this.crumbs.slice(0, -1);
			const parent = next[next.length - 1];
			if (this.mode === 'share') void this.loadShare(parent.fid, next);
			else void this.loadPersonal(parent.fid, next);
		}, this.crumbs.length <= 1);
		if (this.mode === 'share') {
			this.addButton(toolbar, this.label('在夸克官方页面打开', 'Open in Quark'), () => {
				if (this.officialShareUrl) this.actions.openOfficialShare(this.officialShareUrl);
			});
		} else {
			this.addButton(toolbar, this.label('刷新', 'Refresh'), () => {
				const current = this.crumbs[this.crumbs.length - 1];
				void this.loadPersonal(current.fid, this.crumbs);
			});
		}
		const breadcrumb = this.contentEl.createEl('p', { cls: 'quark-browser-breadcrumb' });
		breadcrumb.setText(this.crumbs.map((crumb) => crumb.name).join(' / '));
		if (this.mode === 'share') {
			this.contentEl.createEl('p', {
				cls: 'quark-browser-readonly-note',
				text: this.label('此浏览仅读取分享目录；不显示提取码或会话令牌。', 'This browser only reads the shared directory. Passcodes and session tokens are not displayed.'),
			});
		}
		if (this.mode === 'share' && !this.shareSession) {
			const shareRow = this.contentEl.createDiv({ cls: 'quark-browser-share-input' });
			if (this.passcodeRequired) {
				const password = shareRow.createEl('input');
				password.type = 'password';
				password.autocomplete = 'off';
				password.placeholder = this.label('输入提取码', 'Enter passcode');
				password.setAttribute('aria-label', this.label('分享提取码', 'Share passcode'));
				this.addButton(shareRow, this.label('提交提取码', 'Submit passcode'), () => void this.submitPasscode(password));
			} else {
				const linkInput = shareRow.createEl('input');
				linkInput.type = 'url';
				linkInput.autocomplete = 'off';
				linkInput.placeholder = this.label('粘贴 pan.quark.cn 官方分享链接', 'Paste an official pan.quark.cn share link');
				this.addButton(shareRow, this.label('只读打开', 'Open read only'), () => void this.submitShareUrl(linkInput));
			}
		}
		if (this.loading) this.contentEl.createEl('p', { text: this.label('正在读取…', 'Loading…') });
		if (this.error) {
			this.contentEl.createEl('p', { cls: 'quark-browser-error', text: this.error });
			if (this.mode === 'share' && this.officialShareUrl) {
				this.addButton(this.contentEl, this.label('在夸克官方页面打开', 'Open in Quark'), () => {
					if (this.officialShareUrl) this.actions.openOfficialShare(this.officialShareUrl);
				});
			}
		}
		const list = this.contentEl.createDiv({ cls: 'quark-browser-list' });
		for (const entry of this.entries) this.renderEntry(list, entry);
		if (!this.loading && !this.error && this.entries.length === 0) {
			list.createEl('p', { text: this.label('此目录为空。', 'This folder is empty.') });
		}
	}

	private renderEntry(container: HTMLElement, entry: RemoteFile | ShareEntryLike): void {
		const row = container.createDiv({ cls: 'quark-browser-entry' });
		const isShare = this.mode === 'share';
		const parent = this.crumbs[this.crumbs.length - 1].fid;
		const open = () => {
			if (entry.isDirectory) {
				const crumbs = [...this.crumbs, { fid: entry.fid, name: entry.name }];
				if (isShare) void this.loadShare(entry.fid, crumbs);
				else void this.loadPersonal(entry.fid, crumbs);
			} else if (isShare) {
				this.openShareFile(entry as ShareEntryLike);
			} else {
				void this.actions.previewPersonal(entry, parent, this.insertionTarget).catch((error) => {
					new Notice(error instanceof Error ? error.message : this.label('预览失败。', 'Preview failed.'));
				});
			}
		};
		const openButton = row.createEl('button', { cls: 'quark-browser-entry-name', text: `${entry.isDirectory ? '▸ ' : ''}${entry.name}` });
		openButton.setAttribute('type', 'button');
		openButton.setAttribute('aria-label', entry.name);
		openButton.addEventListener('click', open);
		if (!entry.isDirectory && !isShare) {
			this.addButton(row, this.label('仅插入链接', 'Insert link only'), () => {
				void this.actions.insertReference(entry, parent, this.insertionTarget).catch((error) => {
					new Notice(error instanceof Error ? error.message : this.label('无法插入引用。', 'Could not insert reference.'));
				});
			});
			this.addButton(row, this.label('下载到仓库并插入', 'Download to vault and insert'), () => {
				void this.actions.downloadPersonal(entry, parent, this.insertionTarget).catch((error) => {
					new Notice(error instanceof Error ? error.message : this.label('下载失败。', 'Download failed.'));
				});
			});
		} else if (!entry.isDirectory && isShare && this.shareSession) {
			const shared = entry as ShareEntryLike;
			this.addButton(row, this.label('仅插入链接', 'Insert link only'), () => {
				void this.actions.insertShareReference(this.shareSession!, shared, parent, this.insertionTarget).catch((error) => {
					new Notice(error instanceof Error ? error.message : this.label('无法插入分享链接。', 'Could not insert share link.'));
				});
			});
			if (entry.name.toLowerCase().endsWith('.pdf')) this.addButton(row, this.label('下载到仓库并插入', 'Download to vault and insert'), () => {
				void this.actions.downloadShare(this.shareSession!, shared, parent, this.insertionTarget).catch((error) => {
					new Notice(error instanceof Error ? error.message : this.label('无法下载此分享文件。', 'Could not download this shared file.'));
				});
			});
		}
		row.createEl('span', { cls: 'quark-browser-size', text: entry.isDirectory ? '' : formatBytes(entry.size) });
	}

	private openShareFile(file: ShareEntryLike): void {
		if (!this.shareSession || !this.officialShareUrl) return;
		void this.actions.previewShare(this.shareSession, file, this.officialShareUrl).catch((error) => {
			new Notice(error instanceof Error ? error.message : this.label('分享预览失败。', 'Share preview failed.'));
		});
	}

	private addButton(container: HTMLElement, title: string, callback: () => void, disabled = false): void {
		const button = container.createEl('button', { text: title });
		button.setAttribute('type', 'button');
		button.disabled = disabled;
		button.addEventListener('click', callback);
	}

	private label(chinese: string, english: string): string {
		return this.actions.language === 'en' ? english : chinese;
	}
}

export class QuarkPreviewView extends ItemView {
	private payload: PreviewPayload | undefined;
	private objectUrl: string | undefined;
	private readonly getLanguage: () => 'zh-CN' | 'en';

	constructor(leaf: WorkspaceLeaf, getLanguage: () => 'zh-CN' | 'en' = () => 'zh-CN') {
		super(leaf);
		this.getLanguage = getLanguage;
		this.containerEl.addClass('quark-preview-view');
	}

	getViewType(): string {
		return QUARK_PREVIEW_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.payload?.name ?? (this.label('夸克预览', 'Quark preview'));
	}

	getState(): Record<string, unknown> {
		return {};
	}

	async setState(_state: Record<string, unknown>): Promise<void> {
		this.payload = undefined;
		this.render();
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	async onClose(): Promise<void> {
		this.revokeObjectUrl();
		this.payload = undefined;
	}

	clear(): void {
		this.revokeObjectUrl();
		this.payload = undefined;
		this.contentEl.empty();
	}

	show(payload: PreviewPayload): void {
		this.revokeObjectUrl();
		this.payload = payload;
		this.render();
	}

	private render(): void {
		this.contentEl.empty();
		this.contentEl.addClass('quark-preview-content');
		const payload = this.payload;
		if (!payload) {
			this.contentEl.createEl('p', { text: this.label(
				'预览数据只保留在内存中；重新打开此页签后，需要从夸克网盘再次预览。',
				'Preview data stays in memory. Reopen the item from Quark Drive to preview it again.',
			) });
			return;
		}
		this.contentEl.createEl('p', { cls: 'quark-preview-title', text: payload.name });
		if (payload.message) this.contentEl.createEl('p', { text: payload.message });
		if (payload.kind === 'unsupported') {
			if (payload.download) {
				this.addPreviewButton(this.contentEl, this.label('下载到夸克下载', 'Download to Quark Downloads'), () => void payload.download?.());
			}
			if (payload.officialUrl) {
				this.addPreviewButton(this.contentEl, this.label('在夸克官方页面打开', 'Open official Quark share'), () => window.open(payload.officialUrl, '_blank', 'noopener'));
			}
			return;
		}
		if (payload.kind === 'document' && payload.text !== undefined) {
			this.contentEl.createEl('pre', { cls: 'quark-preview-text', text: payload.text });
			return;
		}
		if (!payload.bytes || !payload.mimeType) {
			this.contentEl.createEl('p', { text: this.label('预览数据不可用。', 'Preview bytes are unavailable.') });
			return;
		}
		const buffer = payload.bytes.buffer.slice(payload.bytes.byteOffset, payload.bytes.byteOffset + payload.bytes.byteLength) as ArrayBuffer;
		this.objectUrl = URL.createObjectURL(new Blob([buffer], { type: payload.mimeType }));
		if (payload.kind === 'image') {
			const image = this.contentEl.createEl('img', { cls: 'quark-preview-image' });
			image.src = this.objectUrl;
			image.alt = payload.name;
		} else if (payload.kind === 'audio') {
			const audio = this.contentEl.createEl('audio', { cls: 'quark-preview-audio' });
			audio.controls = true;
			audio.preload = 'none';
			audio.src = this.objectUrl;
		} else if (payload.kind === 'video') {
			const video = this.contentEl.createEl('video', { cls: 'quark-preview-video' });
			video.controls = true;
			video.preload = 'none';
			video.src = this.objectUrl;
		} else if (payload.kind === 'document') {
			const frame = this.contentEl.createEl('iframe', { cls: 'quark-preview-pdf' });
			frame.src = this.objectUrl;
			frame.title = payload.name;
		}
	}

	private addPreviewButton(container: HTMLElement, label: string, callback: () => void): void {
		const button = container.createEl('button', { text: label });
		button.setAttribute('type', 'button');
		button.addEventListener('click', callback);
	}

	private revokeObjectUrl(): void {
		if (!this.objectUrl) return;
		URL.revokeObjectURL(this.objectUrl);
		this.objectUrl = undefined;
	}

	private label(chinese: string, english: string): string {
		return this.getLanguage() === 'en' ? english : chinese;
	}
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KiB', 'MiB', 'GiB', 'TiB'];
	let value = bytes / 1024;
	for (const unit of units) {
		if (value < 1024 || unit === units[units.length - 1]) return `${value.toFixed(1)} ${unit}`;
		value /= 1024;
	}
	return `${bytes} B`;
}

function isPasscodeError(error: unknown): boolean {
	return Boolean(error && typeof error === 'object' && 'reason' in error && (error as { reason?: unknown }).reason === 'passcode');
}
