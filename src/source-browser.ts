import { mountQuarkVideo, type VideoStream } from './video-stream.ts';
import { ItemView, Notice, Platform, type WorkspaceLeaf } from 'obsidian';
import { mountMobilePdfPreview, type PdfReadingPosition } from './pdf-preview.ts';
import type { RemoteDirectoryPage, RemoteFile } from './quark-api.ts';
import { parseOfficialShareUrl, type PreviewKind } from './quark-references.ts';
import {
	DirectoryChangedDuringSearchError,
	FAVORITE_DIRECTORY_LIMIT,
	PersonalFileSearch,
	RECENT_DIRECTORY_LIMIT,
	type DirectoryCrumb,
	type PersonalDirectoryShortcuts,
} from './personal-file-browser.ts';

export { normalizePersonalDirectoryShortcuts, type DirectoryCrumb, type PersonalDirectoryShortcuts } from './personal-file-browser.ts';
export type { RemoteDirectoryPage as PersonalFileSearchPage } from './quark-api.ts';

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
	stream?: VideoStream;
	name: string;
	kind: PreviewKind;
	bytes?: Uint8Array;
	mimeType?: string;
	text?: string;
	message?: string;
	officialUrl?: string;
	download?: () => Promise<void>;
	pdfPosition?: PdfReadingPosition;
	onPdfPositionChange?: (position: PdfReadingPosition) => void;
}

export interface QuarkBrowserActions {
	language: 'zh-CN' | 'en';
	listPersonal(parentFid: string): Promise<RemoteFile[]>;
	listPersonalSearchPage(parentFid: string, page: number): Promise<RemoteDirectoryPage>;
	getPersonalDirectoryShortcuts(): PersonalDirectoryShortcuts;
	updatePersonalDirectoryShortcuts(update: (current: PersonalDirectoryShortcuts) => PersonalDirectoryShortcuts): Promise<void>;
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

interface SearchState {
	query: string;
	scan: PersonalFileSearch;
	busy: boolean;
	error: string;
}

interface PersonalFileSelection {
	choose: (file: RemoteFile, parentFid: string) => Promise<void>;
	cancel?: () => void;
	busy: boolean;
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
	private fileSelection: PersonalFileSelection | undefined;
	private search: SearchState | undefined;
	private searchDraft = '';
	private searchScope: 'current' | 'drive' = 'current';
	private readonly openShortcutSections = new Set<'recent' | 'favorites'>();

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
		this.resetSearch();
		this.cancelSelection();
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
		await this.loadPersonal('0', this.personalRoot());
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass('quark-browser-view-content');
		this.render();
	}

	async onClose(): Promise<void> {
		this.requestId += 1;
		this.resetSearch();
		this.cancelSelection();
		this.shareSession = undefined;
		this.officialShareUrl = undefined;
	}

	clearSensitiveState(): void {
		this.requestId += 1;
		this.resetSearch();
		this.cancelSelection();
		this.shareSession = undefined;
		this.officialShareUrl = undefined;
		this.entries = [];
		this.crumbs = this.personalRoot();
		this.insertionTarget = undefined;
		this.contentEl.empty();
	}

	setInsertionTarget(target?: SourceEditorTarget): void {
		this.insertionTarget = target;
	}

	setSelectionHandler(choose?: PersonalFileSelection['choose'], cancel?: () => void): void {
		this.cancelSelection();
		if (choose) this.fileSelection = { choose, cancel, busy: false };
		this.render();
	}

	async openShareUrl(rawUrl: string): Promise<void> {
		const parsed = parseOfficialShareUrl(rawUrl);
		const requestId = ++this.requestId;
		this.resetSearch();
		this.cancelSelection();
		this.entries = [];
		if (!parsed) {
			this.shareSession = undefined;
			this.officialShareUrl = undefined;
			this.passcodeRequired = false;
			this.loading = false;
			this.crumbs = [{ fid: '0', name: this.label('分享文件', 'Shared files') }];
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

	private async loadPersonal(fid: string, crumbs: DirectoryCrumb[], remember = true): Promise<void> {
		const requestId = ++this.requestId;
		this.resetSearch();
		this.mode = 'personal';
		this.crumbs = crumbs;
		this.entries = [];
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
		if (remember && fid !== '0' && !this.error) {
			await this.rememberDirectory(fid, crumbs);
			if (requestId !== this.requestId) return;
		}
		this.loading = false;
		this.render();
	}

	private async loadShare(fid: string, crumbs: DirectoryCrumb[]): Promise<void> {
		if (!this.shareSession) return;
		const requestId = ++this.requestId;
		this.mode = 'share';
		this.crumbs = crumbs;
		this.entries = [];
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
			: this.fileSelection
				? this.label('选择夸克网盘文件', 'Select a Quark Drive file')
				: this.label('浏览夸克网盘', 'Browse Quark Drive');
		this.contentEl.createEl('p', { cls: 'quark-browser-title', text: title });
		const toolbar = this.contentEl.createDiv({ cls: 'quark-browser-toolbar' });
		if (this.fileSelection) {
			this.addButton(toolbar, this.label('取消选择', 'Cancel selection'), () => this.setSelectionHandler(), this.fileSelection.busy);
		}
		if (this.mode === 'personal' && this.search) {
			this.addButton(toolbar, this.label('返回目录', 'Back to folder'), () => {
				this.resetSearch();
				this.render();
			});
			this.renderSearchForm();
			this.renderSearchResults(this.search);
			return;
		}
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
			const current = this.crumbs[this.crumbs.length - 1];
			this.addButton(toolbar, this.label('刷新', 'Refresh'), () => {
				void this.loadPersonal(current.fid, this.crumbs, false);
			});
			if (current.fid !== '0' && !this.loading && !this.error) {
				const isFavorite = this.actions.getPersonalDirectoryShortcuts().favorites.some((path) => path[path.length - 1].fid === current.fid);
				const title = isFavorite ? this.label('取消收藏', 'Remove favorite') : this.label('收藏此目录', 'Favorite this folder');
				this.addButton(toolbar, title, () => void this.updateFavorite(this.crumbs, !isFavorite));
			}
		}
		const breadcrumb = this.contentEl.createEl('p', { cls: 'quark-browser-breadcrumb' });
		breadcrumb.setText(this.crumbs.map((crumb) => crumb.name).join(' / '));
		if (this.mode === 'personal') {
			this.renderSearchForm();
			this.renderDirectoryShortcuts();
		}
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

	private personalRoot(): DirectoryCrumb[] {
		return [{ fid: '0', name: this.label('夸克网盘', 'Quark Drive') }];
	}

	private resetSearch(): void {
		this.search = undefined;
		this.searchDraft = '';
		this.searchScope = 'current';
	}

	private renderSearchForm(): void {
		const form = this.contentEl.createEl('form', { cls: 'quark-browser-share-input' });
		const inputLabel = this.label('按文件名搜索', 'Search by file name');
		const input = form.createEl('input', {
			attr: { type: 'search', placeholder: inputLabel, 'aria-label': inputLabel, autocomplete: 'off', required: '' },
		});
		input.value = this.searchDraft;
		input.addEventListener('input', () => { this.searchDraft = input.value; });
		if (this.crumbs.length > 1) {
			const scope = form.createEl('select', { attr: { 'aria-label': this.label('搜索范围', 'Search scope') } });
			scope.createEl('option', { text: this.label('此目录及子目录', 'This folder and subfolders'), value: 'current' });
			scope.createEl('option', { text: this.label('整个网盘', 'Entire drive'), value: 'drive' });
			scope.value = this.searchScope;
			scope.addEventListener('change', () => { this.searchScope = scope.value === 'drive' ? 'drive' : 'current'; });
		}
		const submit = form.createEl('button', { text: this.label('搜索', 'Search'), attr: { type: 'submit' } });
		submit.disabled = this.loading;
		form.addEventListener('submit', (event) => {
			event.preventDefault();
			const query = input.value.trim();
			if (!query || this.loading) return;
			this.searchDraft = query;
			const state: SearchState = {
				query,
				scan: new PersonalFileSearch(query, this.searchScope === 'drive' ? this.personalRoot() : this.crumbs),
				busy: false,
				error: '',
			};
			this.search = state;
			void this.scanSearch(state);
		});
	}

	private async scanSearch(state: SearchState): Promise<void> {
		if (this.search !== state || state.busy) return;
		state.busy = true;
		state.error = '';
		this.render();
		try {
			await state.scan.scan(
				(fid, page) => this.actions.listPersonalSearchPage(fid, page),
				() => this.search === state,
			);
		} catch (error) {
			state.error = error instanceof DirectoryChangedDuringSearchError
				? this.label('目录在搜索期间发生了变化。可重新搜索。', 'The folder changed during the search. Start a new search.')
				: error instanceof Error ? error.message : this.label('无法继续搜索。', 'Could not continue searching.');
		}
		if (this.search !== state) return;
		state.busy = false;
		this.render();
	}

	private renderSearchResults(state: SearchState): void {
		const { busy, error, query, scan } = state;
		const results = scan.results;
		const status = busy
			? this.label(`正在搜索“${query}”…`, `Searching for “${query}”…`)
			: this.label(`找到 ${results.length} 个与“${query}”匹配的文件`, `${results.length} files matching “${query}”`);
		this.contentEl.createEl('p', { text: status, attr: { role: 'status' } });
		if (error) {
			const path = scan.nextFolder?.map((crumb) => crumb.name).join(' / ');
			this.contentEl.createEl('p', {
				cls: 'quark-browser-error',
				text: path ? `${path} · ${error}` : error,
			});
		}
		if (scan.skippedFolders) {
			this.contentEl.createEl('p', {
				text: this.label(`已跳过 ${scan.skippedFolders} 个目录。`, `Skipped ${scan.skippedFolders} folders.`),
			});
		}
		if (!busy && scan.hasMore) {
			const controls = this.contentEl.createDiv({ cls: 'quark-browser-toolbar' });
			const next = error ? this.label('重试此目录', 'Retry this folder') : this.label('继续搜索', 'Continue search');
			this.addButton(controls, next, () => void this.scanSearch(state));
			if (error) {
				this.addButton(controls, this.label('跳过此目录', 'Skip this folder'), () => {
					scan.skipFolder();
					void this.scanSearch(state);
				});
			}
		}
		const list = this.contentEl.createDiv({ cls: 'quark-browser-list' });
		for (const { file, ancestors } of results) {
			list.createDiv({ cls: 'quark-browser-breadcrumb', text: ancestors.map((crumb) => crumb.name).join(' / ') });
			this.renderEntry(list, file, ancestors);
		}
	}

	private renderDirectoryShortcuts(): void {
		const shortcuts = this.actions.getPersonalDirectoryShortcuts();
		for (const kind of ['favorites', 'recent'] as const) {
			const paths = shortcuts[kind];
			const favorite = kind === 'favorites';
			const details = this.contentEl.createEl('details');
			details.open = this.openShortcutSections.has(kind);
			details.addEventListener('toggle', () => {
				if (!details.isConnected) return;
				if (details.open) this.openShortcutSections.add(kind);
				else this.openShortcutSections.delete(kind);
			});
			const title = favorite ? this.label('收藏目录', 'Favorite folders') : this.label('最近使用目录', 'Recent folders');
			details.createEl('summary', { text: `${title} (${paths.length})` });
			if (!paths.length) {
				details.createEl('p', {
					text: favorite ? this.label('还没有收藏目录。', 'No favorite folders yet.') : this.label('还没有访问过的目录。', 'No recently opened folders.'),
					cls: 'quark-browser-breadcrumb',
				});
			}
			for (const path of paths) {
				const crumbs = [...this.personalRoot(), ...path.slice(1)];
				const fid = crumbs[crumbs.length - 1].fid;
				const row = details.createDiv({ cls: 'quark-browser-entry' });
				const button = row.createEl('button', {
					cls: 'quark-browser-entry-name',
					text: crumbs.map((crumb) => crumb.name).join(' / '),
					attr: { type: 'button' },
				});
				button.addEventListener('click', () => void this.loadPersonal(fid, crumbs));
				if (favorite) {
					this.addButton(row, this.label('取消收藏', 'Remove favorite'), () => void this.updateFavorite(crumbs, false));
				}
			}
		}
	}

	private async rememberDirectory(fid: string, crumbs: DirectoryCrumb[]): Promise<void> {
		try {
			await this.actions.updatePersonalDirectoryShortcuts((current) => ({
				recent: [crumbs, ...current.recent.filter((path) => path[path.length - 1].fid !== fid)].slice(0, RECENT_DIRECTORY_LIMIT),
				favorites: current.favorites.map((path) => path[path.length - 1].fid === fid ? crumbs : path),
			}));
		} catch {
			new Notice(this.label('无法保存最近使用目录。', 'Could not save the recent folder.'));
		}
	}

	private async updateFavorite(crumbs: DirectoryCrumb[], add: boolean): Promise<void> {
		const fid = crumbs[crumbs.length - 1].fid;
		const requestId = this.requestId;
		try {
			await this.actions.updatePersonalDirectoryShortcuts((current) => {
				const remaining = current.favorites.filter((path) => path[path.length - 1].fid !== fid);
				if (add && remaining.length >= FAVORITE_DIRECTORY_LIMIT) {
					throw new Error(this.label('收藏已满，请先取消一个收藏。', 'Favorite folders are full. Remove a favorite first.'));
				}
				return { ...current, favorites: add ? [crumbs, ...remaining] : remaining };
			});
			if (requestId === this.requestId) this.render();
		} catch (error) {
			if (requestId === this.requestId) {
				new Notice(error instanceof Error ? error.message : this.label('无法保存收藏目录。', 'Could not save favorite folders.'));
			}
		}
	}

	private cancelSelection(): void {
		const selection = this.fileSelection;
		this.fileSelection = undefined;
		selection?.cancel?.();
	}

	private async chooseFile(selection: PersonalFileSelection, file: RemoteFile, parentFid: string): Promise<void> {
		if (this.fileSelection !== selection || selection.busy) return;
		selection.busy = true;
		this.render();
		try {
			await selection.choose(file, parentFid);
			if (this.fileSelection !== selection) return;
			this.fileSelection = undefined;
		} catch (error) {
			if (this.fileSelection !== selection) return;
			selection.busy = false;
			new Notice(error instanceof Error ? error.message : this.label('无法选择此文件。', 'Could not select this file.'));
		}
		this.render();
	}

	private renderEntry(container: HTMLElement, entry: RemoteFile | ShareEntryLike, ancestors = this.crumbs): void {
		const row = container.createDiv({ cls: 'quark-browser-entry' });
		const isShare = this.mode === 'share';
		const parent = ancestors[ancestors.length - 1].fid;
		const selection = isShare || entry.isDirectory ? undefined : this.fileSelection;
		const open = () => {
			if (entry.isDirectory) {
				const crumbs = [...ancestors, { fid: entry.fid, name: entry.name }];
				if (isShare) void this.loadShare(entry.fid, crumbs);
				else void this.loadPersonal(entry.fid, crumbs);
			} else if (isShare) {
				this.openShareFile(entry as ShareEntryLike);
			} else if (selection) {
				void this.chooseFile(selection, entry, parent);
			} else {
				void this.actions.previewPersonal(entry, parent, this.insertionTarget).catch((error) => {
					new Notice(error instanceof Error ? error.message : this.label('预览失败。', 'Preview failed.'));
				});
			}
		};
		const openButton = row.createEl('button', { cls: 'quark-browser-entry-name', text: `${entry.isDirectory ? '▸ ' : ''}${entry.name}` });
		openButton.setAttribute('type', 'button');
		openButton.setAttribute('aria-label', entry.name);
		openButton.disabled = selection?.busy ?? false;
		openButton.addEventListener('click', open);
		if (selection) {
			this.addButton(row, this.label('选择此文件', 'Select file'), open, selection.busy);
		} else if (!entry.isDirectory && !isShare) {
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
		row.createSpan({ cls: 'quark-browser-size', text: entry.isDirectory ? '' : formatBytes(entry.size) });
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
	private stopVideo?: () => void;
	private stopPdf?: () => void;
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
		this.revokeObjectUrl();
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
		if (payload.stream) {
			this.stopVideo = mountQuarkVideo(this.contentEl, payload.stream);
			return;
		}
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
		if (Platform.isMobileApp && payload.kind === 'document' && payload.mimeType === 'application/pdf') {
			this.renderMobilePdf(payload, payload.bytes);
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

	private renderMobilePdf(payload: PreviewPayload, bytes: Uint8Array): void {
		this.stopPdf = mountMobilePdfPreview(this.contentEl, bytes, this.getLanguage(), () => {
			if (payload.download) {
				this.addPreviewButton(this.contentEl, this.label('下载到夸克下载', 'Download to Quark Downloads'), () => void payload.download?.());
			}
			if (payload.officialUrl) {
				this.addPreviewButton(this.contentEl, this.label('在夸克中打开', 'Open in Quark'), () => window.open(payload.officialUrl, '_blank', 'noopener'));
			}
		}, payload.pdfPosition, payload.onPdfPositionChange);
	}

	private addPreviewButton(container: HTMLElement, label: string, callback: () => void): void {
		const button = container.createEl('button', { text: label });
		button.setAttribute('type', 'button');
		button.addEventListener('click', callback);
	}

	private revokeObjectUrl(): void {
		this.stopPdf?.();
		this.stopPdf = undefined;
		this.stopVideo?.();
		this.stopVideo = undefined;
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
