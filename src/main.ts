import { mountQuarkVideo } from './video-stream.ts';
import { hasAsciiControl } from './core.ts';
import {
	Modal,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	requireApiVersion,
	Setting,
	MarkdownView,
	MarkdownRenderChild,
	Menu,
	type App,
	type Editor,
	type MarkdownFileInfo,
	type TAbstractFile,
	type TextComponent,
	type SettingDefinitionItem,
	type WorkspaceLeaf,
} from 'obsidian';
import QRCode from 'qrcode';
import type { PendingApplyState, SyncSummary } from './sync-service.ts';
import { QuarkSyncService } from './sync-service.ts';
import type { SyncPlan, SyncSnapshot } from './sync-engine.ts';
import { QuarkAuthenticationError, QuarkClient, type RemoteFile } from './quark-api.ts';
import { QuarkTransport, type HttpRequest, type HttpResponse } from './transport.ts';
import { QuarkQrLogin, type QuarkQrSession } from './quark-login.ts';
import { createPairingCode, readPairingCode } from './pairing-code.ts';
import { settingsText, type Language } from './settings-text.ts';
import { DASHBOARD_VIEW_TYPE, QuarkDashboardSidebar, type QuarkDashboardActions, type QuarkDashboardView } from './dashboard.ts';
import { summarizeVaultFiles } from './dashboard-stats.ts';
import { addSourceIndexEntry, chooseDownloadPath, managedDownloadPaths, moveSourceIndexPath, normalizeSourceIndex, QUARK_DOWNLOADS_DIRECTORY, type SourceIndex, type SourceIndexEntry } from './source-index.ts';
import { accountReferenceKey, findOfficialShareUrl, formatPersonalReference, formatPublicShareReference, MAX_PERSONAL_DOWNLOAD_BYTES, isInlineMediaName, loadWhenVisible, mapInsertionRange, mimeTypeForFile, parseOfficialShareUrl, parsePersonalReference, previewKindForFile, type PersonalReference, type PreviewKind } from './quark-references.ts';
import {
	QUARK_BROWSER_VIEW_TYPE,
	QUARK_PREVIEW_VIEW_TYPE,
	QuarkBrowserView,
	QuarkPreviewView,
	type PreviewPayload,
	type QuarkBrowserActions,
	type ShareEntryLike,
	type ShareSessionLike,
	type SourceEditorTarget,
} from './source-browser.ts';
import { QuarkShareClient } from './share-api.ts';
import { sha256Hex } from './hash.ts';
import { createReferenceLivePreview } from './live-preview.ts';

const PLUGIN_ID = 'quark-note-sync';
const DEFAULT_CLOUD_DIRECTORY = 'Obsidian Notes';
const DEFAULT_AUTO_SYNC_MINUTES = 5;

interface PluginSettings {
	language: Language;
	cloudDirectoryName: string;
	deviceName: string;
	autoSync: boolean;
	syncOnStartup: boolean;
	sessionExpired: boolean;
	autoSyncIntervalMinutes: number;
	initialSyncCompleted: boolean;
	lastSummary: SyncSummary | null;
	lastSyncedAt: number | null;
	deviceId: string;
	boundAccountId: string | null;
	boundRootFid: string | null;
	snapshots: Record<string, SyncSnapshot>;
	pendingApplies: Record<string, PendingApplyState>;
	sourceIndex: SourceIndex;
}

type PersistedData = Partial<PluginSettings>;
interface InspectedCredential {
	accountId: string;
	rootFid?: string;
	cookie: string;
	nickname?: string;
}

interface DashboardPreview {
	plan: SyncPlan;
	confirm: boolean;
	directory: string;
	credentialRevision: number;
}

type AccountView = { state: 'signed-out' | 'expired' } | { state: 'connected'; label: string };

export default class QuarkNoteSyncPlugin extends Plugin {
	private config!: PluginSettings;
	private busy = false;
	private unloading = false;
	private autoSyncTimer: number | undefined;
	private credentialId = '';
	private credentialRevision = 0;
	private inlineMediaQueue: Promise<void> = Promise.resolve();
	private startupSyncPending = true;
	private layoutReady = false;
	private accountNickname: string | undefined;
	private settingsTab!: QuarkSettingsTab;
	private loginModal: QuarkLoginModal | undefined;
	private dashboard: QuarkDashboardSidebar | undefined;
	private dashboardLeafPending: Promise<WorkspaceLeaf> | undefined;
	private dashboardOpening: Promise<void> | undefined;
	private dashboardPreview: DashboardPreview | undefined;
	private dashboardVault: ReturnType<typeof summarizeVaultFiles> | undefined;
	private dashboardQuota: { usedBytes: number; freeBytes: number } | undefined;
	private dashboardQuotaLoading = false;
	private dashboardRequest = 0;

	async onload(): Promise<void> {
		const data = (await this.loadData()) as PersistedData | null;
		this.config = normalizeSettings(data ?? {});
		this.credentialId = `${PLUGIN_ID}-cookie-${this.config.deviceId}`;
		this.settingsTab = new QuarkSettingsTab(this.app, this);
		this.addSettingTab(this.settingsTab);

		const dashboardName = this.config.language === 'en' ? 'Open sync dashboard' : '打开同步面板';
		this.registerView(DASHBOARD_VIEW_TYPE, (leaf) => this.createDashboardView(leaf));
		this.registerView(QUARK_BROWSER_VIEW_TYPE, (leaf) => new QuarkBrowserView(leaf, this.browserActions()));
		this.registerView(QUARK_PREVIEW_VIEW_TYPE, (leaf) => new QuarkPreviewView(leaf, () => this.config.language));
		this.registerEditorExtension(createReferenceLivePreview({
			language: () => this.config.language,
			loadMedia: (reference, visible) => this.loadVisiblePersonalMedia(reference, visible),
			openReference: async (reference, showMedia) => await this.openPersonalReference({
				account: reference.accountKey,
				fid: reference.fid,
			}, showMedia),
			openShare: async (rawUrl, showMedia) => await this.openPublicShare(rawUrl, showMedia, this.captureActiveEditorTarget()),
			reportError: (error) => new Notice(error instanceof Error ? error.message : this.config.language === 'en' ? 'Could not open the Quark file.' : '无法打开夸克文件。'),
		}));
		this.addRibbonIcon('cloud', dashboardName, () => void this.openDashboard());
		this.addCommand({ id: 'open-dashboard', name: dashboardName, callback: () => void this.openDashboard() });
		this.addCommand({
			id: 'browse-quark-drive',
			name: this.config.language === 'en' ? 'Browse Quark Drive' : '浏览夸克网盘',
			callback: () => void this.openBrowser(),
		});
		this.addCommand({
			id: 'insert-quark-reference',
			name: this.config.language === 'en' ? 'Insert Quark Drive file' : '插入夸克网盘文件',
			callback: () => void this.openBrowser(this.captureActiveEditorTarget()),
		});
		this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, info) => {
			this.addEditorMenuItems(menu, editor, info);
		}));
		this.registerMarkdownPostProcessor((element, context) => {
			const inlineMedia = new QuarkInlineMediaChild(element);
			context.addChild(inlineMedia);
			for (const anchor of Array.from(element.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
				const rawUrl = anchor.href;
				if (anchor.dataset.quarkShareHandler !== '1') {
					if (parseOfficialShareUrl(rawUrl)) {
						anchor.dataset.quarkShareHandler = '1';
						anchor.title = this.config.language === 'en'
							? 'Open read-only Quark share browser'
							: '在只读视图中打开夸克分享';
						inlineMedia.onClick(anchor, (event) => {
							event.preventDefault();
							event.stopPropagation();
							void this.openPublicShare(rawUrl, (payload) => {
								if (!anchor.isConnected) return;
								const media = createInlineMedia(payload, inlineMedia);
								if (media) anchor.after(media);
							});
						});
						continue;
					}
					const reference = parsePersonalReference(rawUrl);
					if (!reference) continue;
					anchor.dataset.quarkShareHandler = '1';
					anchor.title = this.config.language === 'en'
						? 'Open Quark file; images and audio/video load inline on demand'
						: '打开夸克文件；图片和音视频会按需内嵌加载';
					let rendered = false;
					const show = (payload: PreviewPayload) => {
						if (rendered || !anchor.isConnected) return;
						const media = createInlineMedia(payload, inlineMedia);
						if (!media) return;
						rendered = true;
						anchor.after(media);
					};
					inlineMedia.onClick(anchor, (event) => {
						event.preventDefault();
						event.stopPropagation();
						if (!rendered) void this.openPersonalReference({ account: reference.accountKey, fid: reference.fid }, show);
					});
					if (isInlineMediaName(anchor.textContent ?? '')) {
						inlineMedia.whenVisible(anchor, () => void this.loadVisiblePersonalMedia(reference, () => anchor.isConnected && !rendered).then((payload) => {
							if (payload) show(payload);
						}).catch(() => {}));
					}
				}
			}
			for (const image of Array.from(element.querySelectorAll<HTMLImageElement>('img[src]'))) {
				const reference = parsePersonalReference(image.getAttribute('src') ?? image.src);
				if (!reference || image.dataset.quarkShareHandler === '1') continue;
				image.dataset.quarkShareHandler = '1';
				const button = createEl('button');
				button.type = 'button';
				button.className = 'quark-inline-load-button';
				button.textContent = this.config.language === 'en' ? `Load ${image.alt || 'Quark image'}` : `加载${image.alt || '夸克图片'}`;
				button.setAttribute('aria-label', button.textContent);
				image.replaceWith(button);
				inlineMedia.whenVisible(button, () => void this.loadVisiblePersonalMedia(reference, () => button.isConnected).then((payload) => {
					if (!payload || !button.isConnected) return;
					const media = createInlineMedia(payload, inlineMedia);
					if (media) button.replaceWith(media);
				}).catch(() => {}));
				inlineMedia.onClick(button, (event) => {
					event.preventDefault();
					button.disabled = true;
					void this.openPersonalReference({ account: reference.accountKey, fid: reference.fid }, (payload) => {
						const media = createInlineMedia(payload, inlineMedia);
						if (media && button.isConnected) button.replaceWith(media);
					}).then(() => {
						if (button.isConnected) button.disabled = false;
					}).catch((error: unknown) => {
						if (button.isConnected) button.disabled = false;
						new Notice(error instanceof Error ? error.message : this.config.language === 'en' ? 'Could not load the Quark image.' : '无法加载夸克图片。');
					});
				});
			}
		});
		this.registerObsidianProtocolHandler('quark-note', (params) => void this.openPersonalReference(params));
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.updateSourceIndexPath(file, oldPath)));

		this.addCommand({
			id: 'preview-sync',
			name: '预览同步变化',
			callback: () => void this.previewSync(),
		});
		this.addCommand({
			id: 'sync-now',
			name: '立即同步夸克',
			callback: () => void this.requestSync(),
		});
		this.addCommand({
			id: 'check-quark-connection',
			name: '检查夸克连接',
			callback: () => void this.checkConnection(),
		});
		this.addCommand({
			id: 'quark-qr-login',
			name: '夸克扫码登录',
			checkCallback: (checking) => {
				if (this.accountView.state === 'connected' || this.busy || this.unloading) return false;
				if (!checking) this.openQrLogin();
				return true;
			},
		});
		this.addCommand({
			id: 'export-quark-pairing',
			name: '导出到手机',
			callback: () => new ExportPairingModal(this.app, this).open(),
		});
		this.addCommand({
			id: 'import-quark-pairing',
			name: '导入电脑授权',
			callback: () => new ImportPairingModal(this.app, this).open(),
		});

		this.app.workspace.onLayoutReady(() => {
			this.layoutReady = true;
			if (!this.unloading && Platform.isDesktopApp) void this.ensureDashboardLeaf().catch(() => undefined);
			this.runStartupSync();
		});
		this.refreshAutoSyncTimer();
	}

	onunload(): void {
		this.unloading = true;
		this.loginModal?.close();
		for (const leaf of this.app.workspace.getLeavesOfType(QUARK_BROWSER_VIEW_TYPE)) {
			if (leaf.view instanceof QuarkBrowserView) leaf.view.clearSensitiveState();
		}
		for (const leaf of this.app.workspace.getLeavesOfType(QUARK_PREVIEW_VIEW_TYPE)) {
			if (leaf.view instanceof QuarkPreviewView) leaf.view.clear();
		}
		this.dashboard = undefined;
		this.dashboardPreview = undefined;
		this.dashboardRequest += 1;
		if (this.autoSyncTimer !== undefined) {
			window.clearInterval(this.autoSyncTimer);
			this.autoSyncTimer = undefined;
		}
	}

	private async openBrowser(target?: SourceEditorTarget, mode: 'personal' | 'share' = 'personal'): Promise<QuarkBrowserView | undefined> {
		if (this.unloading) return undefined;
		try {
			const leaf = this.app.workspace.getLeaf('tab');
			await leaf.setViewState({ type: QUARK_BROWSER_VIEW_TYPE, state: { mode }, active: true });
			await leaf.loadIfDeferred();
			const view = leaf.view as QuarkBrowserView;
			view.setInsertionTarget(target);
			return view;
		} catch {
			new Notice(this.config.language === 'en' ? 'Could not open the Quark browser tab.' : '无法打开夸克浏览页签。');
			return undefined;
		}
	}

	private async openPublicShare(
		rawUrl: string,
		showInlineMedia?: (payload: PreviewPayload) => void,
		target?: SourceEditorTarget,
	): Promise<void> {
		const share = parseOfficialShareUrl(rawUrl);
		if (!share || this.unloading) return;
		if (share.selectedFid) {
			const shareKey = await sha256Hex(new TextEncoder().encode(`quark-public-share-reference:${share.pwdId}`));
			const cached = this.findIndexedSource(shareKey, share.selectedFid);
			if (cached && await this.previewCachedSource(cached, showInlineMedia)) return;
		}
		if (showInlineMedia) {
			try {
				const client = this.createShareClient();
				const session = await client.openShare(share.pwdId, share.passcode);
				const entries = await client.listDirectory(session, share.selectedParentFid ?? '0');
				const file = share.selectedFid
					? entries.find((entry) => entry.fid === share.selectedFid)
					: entries.length === 1 ? entries[0] : undefined;
				if (file && !file.isDirectory && previewKindForFile(file.name).kind === 'video') {
					const url = await client.getVideoStream(session, file);
					if (!this.unloading) showInlineMedia({
						name: file.name, kind: 'video',
						stream: { url, transport: this.createTransport(), language: this.config.language, officialUrl: share.officialUrl },
					});
					return;
				}
				if (file && !file.isDirectory && previewKindForFile(file.name).kind === 'image') {
					const payload = await client.previewDocumentOrImage(session, file);
					if (!this.unloading) showInlineMedia(createPreviewPayload(file.name, 'image', payload.bytes, payload.mimeType));
					return;
				}
			} catch {
				// The share tab handles passcodes, expired links, and provider restrictions.
			}
		}
		const view = await this.openBrowser(target, 'share');
		if (view && !this.unloading) await view.openShareUrl(rawUrl);
	}

	private addEditorMenuItems(menu: Menu, editor: Editor, info: MarkdownFileInfo): void {
		const target = this.captureEditorTarget(editor, info);
		menu.addItem((item) => item
			.setTitle(this.config.language === 'en' ? 'Insert Quark Drive file' : '插入夸克网盘文件')
			.setIcon('cloud')
			.onClick(() => void this.openBrowser(target)));
		const selection = editor.getSelection();
		const currentLine = editor.getLine(editor.getCursor().line);
		const shareUrl = findOfficialShareUrl(selection) ?? findOfficialShareUrl(currentLine);
		if (shareUrl) {
			menu.addItem((item) => item
				.setTitle(this.config.language === 'en' ? 'Open public Quark share (read only)' : '只读打开夸克公开分享')
				.setIcon('external-link')
				.onClick(() => void this.openPublicShare(shareUrl, undefined, target)));
		}
	}

	private captureActiveEditorTarget(): SourceEditorTarget | undefined {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		return view ? this.captureEditorTarget(view.editor, view) : undefined;
	}

	private captureEditorTarget(editor: Editor, info?: MarkdownFileInfo): SourceEditorTarget | undefined {
		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		const sourceView = info?.editor === editor ? info as MarkdownView : active;
		const path = info?.file?.path ?? sourceView?.file?.path;
		if (!sourceView || !path || sourceView.file?.path !== path) return undefined;
		let originalText = editor.getValue();
		let from = editor.posToOffset(editor.getCursor('from'));
		let to = editor.posToOffset(editor.getCursor('to'));
		return {
			insert: (markdown) => {
				if (sourceView.file?.path !== path || sourceView.editor !== editor) return false;
				const currentText = editor.getValue();
				const mapped = mapInsertionRange(originalText, currentText, from, to);
				if (!mapped) return false;
				const [start, end] = mapped;
				const separator = start > 0 && !/\s/.test(currentText[start - 1]) ? ' ' : '';
				const inserted = separator + markdown;
				editor.replaceRange(inserted, editor.offsetToPos(start), editor.offsetToPos(end));
				from = to = start + inserted.length;
				originalText = editor.getValue();
				return true;
			},
		};
	}

	private browserActions(): QuarkBrowserActions {
		return {
			language: this.config.language,
			listPersonal: async (parentFid) => await this.createClient(this.requireCookie()).listDirectory(parentFid),
			openShare: async (pwdId, passcode) => await this.createShareClient().openShare(pwdId, passcode),
			listShare: async (session, parentFid) => await this.createShareClient().listDirectory(session, parentFid),
			previewPersonal: async (file, parentFid, target) => await this.previewPersonalFile(file, parentFid, target),
			downloadPersonal: async (file, _parentFid, target) => await this.downloadPersonalFile(file, target),
			insertReference: async (file, _parentFid, target) => this.insertPersonalReference(file, target),
			insertShareReference: async (session, file, parentFid, target) => this.insertShareReference(session, file, parentFid, target),
			previewShare: async (session, file, officialUrl) => await this.previewShareFile(session, file, officialUrl),
			downloadShare: async (session, file, parentFid, target) => await this.downloadShareFile(session, file, parentFid, target),
			openOfficialShare: (url) => { window.open(url, '_blank', 'noopener'); },
		};
	}

	private async previewPersonalFile(file: RemoteFile, _parentFid: string, target?: SourceEditorTarget): Promise<void> {
		const preview = previewKindForFile(file.name);
		if (preview.kind === 'unsupported' || (preview.kind !== 'video' && file.size > preview.maxBytes)) {
			await this.openPreviewTab({
				name: file.name,
				kind: 'unsupported',
				message: preview.kind === 'unsupported'
					? this.config.language === 'en' ? 'This file type has no safe inline preview.' : '此文件类型没有安全的内嵌预览。'
					: this.config.language === 'en' ? 'This file exceeds the preview size limit.' : '文件超过预览大小上限。',
				download: async () => await this.downloadPersonalFile(file, target),
			});
			return;
		}
		await this.runExclusive(this.config.language === 'en' ? 'Preview Quark file' : '预览夸克文件', async () => {
			const client = this.createClient(this.requireCookie());
			await this.openPreviewTab(await this.readPersonalPreview(client, file, preview.kind, preview.maxBytes));
		}, true);
	}

	private async previewShareFile(session: ShareSessionLike, file: ShareEntryLike, officialUrl: string): Promise<void> {
		if (previewKindForFile(file.name).kind === 'video') {
			try {
				const url = await this.createShareClient().getVideoStream(session, file);
				await this.openPreviewTab({ name: file.name, kind: 'video', stream: { url, transport: this.createTransport(), language: this.config.language, officialUrl } });
				return;
			} catch {
				// The original share is still available for playback in Quark.
			}
		}
		if (previewKindForFile(file.name).kind === 'image' || /\.pdf$/i.test(file.name)) {
			try {
				const result = await this.createShareClient().previewDocumentOrImage(session, file);
				const kind: PreviewKind = result.mimeType === 'application/pdf' ? 'document' : 'image';
				await this.openPreviewTab(createPreviewPayload(file.name, kind, result.bytes, result.mimeType, undefined, officialUrl));
				return;
			} catch {
				// Use the original share link when Quark restricts the preview.
			}
		}
		await this.openPreviewTab({
			name: file.name,
			kind: 'unsupported',
			message: this.config.language === 'en' ? 'Preview unavailable for this share.' : '预览暂不可用。',
			officialUrl,
		});
	}

	private async downloadPersonalFile(file: RemoteFile, target?: SourceEditorTarget): Promise<void> {
		const result = await this.runExclusive(this.config.language === 'en' ? 'Download Quark file' : '下载夸克文件', async () => {
			if (file.size > MAX_PERSONAL_DOWNLOAD_BYTES) throw new Error(this.config.language === 'en'
				? 'This file exceeds the 100 MiB download limit.'
				: '此文件超过 100 MiB 下载上限。');
			const client = this.createClient(this.requireCookie());
			const accountId = await client.checkConnection();
			if (!accountId) throw new Error('夸克未返回稳定账号编号');
			if (this.config.boundAccountId && accountId !== this.config.boundAccountId) {
				throw new Error('当前夸克账号与此笔记库绑定的账号不一致');
			}
			const accountKey = await accountReferenceKey(accountId);
			const bytes = await client.downloadFile(file, MAX_PERSONAL_DOWNLOAD_BYTES);
			const path = await this.saveQuarkDownload(file.name, bytes, { accountKey, fid: file.fid });
			return { path, accountKey };
		}, true);
		if (!result) return;
		if (target && !target.insert(formatPersonalReference(file.name, result.accountKey, file.fid))) {
			new Notice(this.config.language === 'en'
				? `Saved ${result.path}, but the source note changed, so the link was not inserted.`
				: `已保存到 ${result.path}；来源笔记已变化，因此没有插入链接。`);
			return;
		}
		new Notice(this.config.language === 'en' ? `Saved to ${result.path}` : `已下载到 ${result.path}`);
	}

	private async downloadShareFile(
		session: ShareSessionLike,
		file: ShareEntryLike,
		parentFid: string,
		target?: SourceEditorTarget,
	): Promise<void> {
		const result = await this.runExclusive(this.config.language === 'en' ? 'Download public share PDF' : '下载公开分享 PDF', async () => {
			const shareKey = await sha256Hex(new TextEncoder().encode(`quark-public-share-reference:${session.pwdId}`));
			const bytes = await this.createShareClient().downloadFile(session, file, 20 * 1024 * 1024);
			const path = await this.saveQuarkDownload(file.name, bytes.bytes, { accountKey: shareKey, fid: file.fid });
			return path;
		});
		if (!result) return;
		if (target && !target.insert(formatPublicShareReference(file.name, session.pwdId, file.fid, parentFid))) {
			new Notice(this.config.language === 'en'
				? `Saved ${result}, but the source note changed, so the link was not inserted.`
				: `已保存到 ${result}；来源笔记已变化，因此没有插入链接。`);
			return;
		}
		new Notice(this.config.language === 'en' ? `Saved to ${result}` : `已下载到 ${result}`);
	}

	private async insertPersonalReference(file: RemoteFile, target?: SourceEditorTarget): Promise<void> {
		const accountId = this.config.boundAccountId;
		if (!target) {
			new Notice(this.config.language === 'en' ? 'Open a Markdown note before inserting a link.' : '请先打开 Markdown 笔记，再插入链接。');
			return;
		}
		if (!accountId) {
			new Notice(this.config.language === 'en' ? 'The Quark account ID is not available.' : '当前没有可用的夸克账号编号。');
			return;
		}
		const inserted = target.insert(formatPersonalReference(file.name, await accountReferenceKey(accountId), file.fid));
		if (!inserted) new Notice(this.config.language === 'en'
			? 'The source note changed, so the link was not inserted.'
			: '来源笔记已变化，因此没有插入链接。');
	}

	private async insertShareReference(
		session: ShareSessionLike,
		file: ShareEntryLike,
		parentFid: string,
		target?: SourceEditorTarget,
	): Promise<void> {
		if (!target) {
			new Notice(this.config.language === 'en' ? 'Open a Markdown note before inserting a link.' : '请先打开 Markdown 笔记，再插入链接。');
			return;
		}
		const inserted = target.insert(formatPublicShareReference(file.name, session.pwdId, file.fid, parentFid));
		if (!inserted) new Notice(this.config.language === 'en'
			? 'The source note changed, so the link was not inserted.'
			: '来源笔记已变化，因此没有插入链接。');
	}

	private async saveQuarkDownload(name: string, bytes: Uint8Array, source: { accountKey: string; fid: string }): Promise<string> {
		await this.ensureQuarkDownloadsFolder();
		const paths = new Set<string>([
			...(this.app.vault.getFolderByPath(QUARK_DOWNLOADS_DIRECTORY)?.children ?? []).map((file) => file.path),
			...Object.keys(this.config.snapshots),
			...Object.keys(this.config.pendingApplies),
			...managedDownloadPaths(this.config.sourceIndex),
		]);
		let path = chooseDownloadPath(name, paths);
		for (let attempt = 0; attempt < 100; attempt += 1) {
			if (!(await this.app.vault.adapter.exists(path))) break;
			paths.add(path);
			path = chooseDownloadPath(name, paths);
		}
		if (await this.app.vault.adapter.exists(path)) throw new Error('夸克下载文件重名过多，无法安全保存');
		const entry: SourceIndexEntry = {
			...source,
			name,
			size: bytes.byteLength,
			localPath: path,
			sha256: await sha256Hex(bytes),
			downloadedAt: Date.now(),
		};
		this.config.sourceIndex = addSourceIndexEntry(this.config.sourceIndex, entry);
		await this.persistData();
		await this.app.vault.createBinary(path, toArrayBuffer(bytes));
		return path;
	}

	private async ensureQuarkDownloadsFolder(): Promise<void> {
		const path = QUARK_DOWNLOADS_DIRECTORY;
		if (await this.app.vault.adapter.exists(path)) {
			const stat = await this.app.vault.adapter.stat(path);
			if (stat?.type !== 'folder') throw new Error('Quark Downloads is occupied by a file; no file was overwritten');
			return;
		}
		try {
			await this.app.vault.createFolder(path);
		} catch {
			const stat = await this.app.vault.adapter.stat(path);
			if (stat?.type !== 'folder') throw new Error('无法安全创建 Quark Downloads 文件夹');
		}
	}

	private async openPreviewTab(payload: PreviewPayload): Promise<void> {
		if (this.unloading) return;
		const leaf = this.app.workspace.getLeaf('tab');
		await leaf.setViewState({ type: QUARK_PREVIEW_VIEW_TYPE, active: true });
		await leaf.loadIfDeferred();
		const view = leaf.view as QuarkPreviewView;
		view.show(payload);
	}

	private createShareClient(): QuarkShareClient {
		const transport = this.createTransport();
		return new QuarkShareClient({
			request: async (request: HttpRequest): Promise<HttpResponse> => {
				if (this.unloading) throw new Error('插件已卸载，已停止夸克分享请求');
				return await transport.request(request);
			},
		});
	}

	private loadVisiblePersonalMedia(reference: PersonalReference, visible: () => boolean): Promise<PreviewPayload | undefined> {
		const task = this.inlineMediaQueue.then(async () => {
			if (this.unloading || !visible()) return;
			const cached = this.findIndexedSource(reference.accountKey, reference.fid);
			let payload: PreviewPayload | undefined;
			if (cached && isInlineMediaName(cached.name) && await this.previewCachedSource(cached, (result) => { payload = result; }, true)) return payload;
			const cookie = this.readCookie();
			if (!cookie || this.config.sessionExpired) return;
			const revision = this.credentialRevision;
			const client = this.createClient(cookie);
			const accountId = await client.checkConnection();
			if (!accountId || await accountReferenceKey(accountId) !== reference.accountKey ||
				revision !== this.credentialRevision || !visible()) return;
			const file = await client.getFileById(reference.fid);
			const { kind, maxBytes } = previewKindForFile(file.name);
			if (file.isDirectory || !isInlineMediaName(file.name) || (kind !== 'video' && file.size > maxBytes) || !visible()) return;
			const onlinePayload = await this.readPersonalPreview(client, file, kind, maxBytes);
			if (!this.unloading && revision === this.credentialRevision && visible()) {
				return onlinePayload;
			}
		});
		this.inlineMediaQueue = task.then(() => {}, () => {});
		return task;
	}

	private async openPersonalReference(
		params: Record<string, string>,
		showInlineMedia?: (payload: PreviewPayload) => void,
	): Promise<void> {
		if (Object.keys(params).some((key) => !['action', 'account', 'fid'].includes(key)) ||
			(params.action !== undefined && params.action !== 'quark-note')) {
			new Notice(this.config.language === 'en' ? 'This Quark reference is malformed.' : '夸克引用格式无效。');
			return;
		}
		const link = new URL('obsidian://quark-note');
		link.searchParams.set('account', params.account ?? '');
		link.searchParams.set('fid', params.fid ?? '');
		const reference = parsePersonalReference(link.toString());
		if (!reference) {
			new Notice(this.config.language === 'en' ? 'This Quark reference is malformed.' : '夸克引用格式无效。');
			return;
		}
		const cached = this.findIndexedSource(reference.accountKey, reference.fid);
		if (cached && await this.previewCachedSource(cached, showInlineMedia)) return;
		const cookie = this.readCookie();
		if (!cookie || this.config.sessionExpired) {
			new Notice(this.config.language === 'en'
				? 'Connect to Quark to open this reference. No local download is available offline.'
				: '请连接夸克以打开此引用；当前没有可用的离线下载。');
			return;
		}
		await this.runExclusive(this.config.language === 'en' ? 'Open Quark reference' : '打开夸克引用', async () => {
			const client = this.createClient(cookie);
			const accountId = await client.checkConnection();
			const currentAccountKey = accountId ? await accountReferenceKey(accountId) : '';
			if (currentAccountKey !== reference.accountKey) {
				if (cached && await this.previewCachedSource(cached, showInlineMedia)) return true;
				throw new Error('此引用属于另一个夸克账号');
			}
			try {
				const file = await client.getFileById(reference.fid);
				if (file.isDirectory) throw new Error('夸克引用指向的是文件夹，请从浏览器中打开');
				await this.previewPersonalContent(client, file, cached, showInlineMedia);
			} catch (error) {
				if (cached && await this.previewCachedSource(cached, showInlineMedia)) return true;
				throw error;
			}
			return true;
		}, true);
	}

	private async previewPersonalContent(
		client: QuarkClient,
		file: RemoteFile,
		cached?: SourceIndexEntry,
		showInlineMedia?: (payload: PreviewPayload) => void,
	): Promise<void> {
		const preview = previewKindForFile(file.name);
		if (preview.kind === 'unsupported' || (preview.kind !== 'video' && file.size > preview.maxBytes)) {
			await this.openPreviewTab({
				name: file.name,
				kind: 'unsupported',
				message: preview.kind === 'unsupported'
					? this.config.language === 'en' ? 'This file type has no safe inline preview.' : '此文件类型没有安全的内嵌预览。'
					: this.config.language === 'en' ? 'This file exceeds the preview size limit.' : '文件超过预览大小上限。',
				download: async () => await this.downloadPersonalFile(file),
			});
			return;
		}
		try {
			const payload = await this.readPersonalPreview(client, file, preview.kind, preview.maxBytes);
			if (showInlineMedia && (preview.kind === 'image' || preview.kind === 'audio' || preview.kind === 'video')) showInlineMedia(payload);
			else await this.openPreviewTab(payload);
		} catch (error) {
			if (cached && await this.previewCachedSource(cached, showInlineMedia)) return;
			throw error;
		}
	}

	private async readPersonalPreview(client: QuarkClient, file: RemoteFile, kind: PreviewKind, maxBytes: number): Promise<PreviewPayload> {
		if (kind === 'video') {
			try {
				const url = await client.getVideoStream(file);
				const revision = this.credentialRevision;
				return {
					name: file.name, kind, stream: {
						url, language: this.config.language, officialUrl: 'https://pan.quark.cn/',
						transport: { request: async (request) => {
							if (this.unloading || revision !== this.credentialRevision || this.config.sessionExpired) {
								throw new Error('夸克播放会话已变化');
							}
							return await client.requestVideoSegment(request);
						} },
					},
				};
			} catch (error) {
				if (error instanceof QuarkAuthenticationError || file.size > maxBytes) throw error;
			}
		}
		if (kind === 'image') {
			const { bytes, mimeType } = await client.previewImage(file, maxBytes);
			return createPreviewPayload(file.name, kind, bytes, mimeType);
		}
		const bytes = await client.downloadFile(file, maxBytes);
		return createPreviewPayload(file.name, kind, bytes, mimeTypeForFile(file.name));
	}

	private findIndexedSource(accountKey: string, fid: string): SourceIndexEntry | undefined {
		return Object.values(this.config.sourceIndex)
			.filter((entry) => entry.accountKey === accountKey && entry.fid === fid)
			.sort((left, right) => right.downloadedAt - left.downloadedAt)[0];
	}

	private async previewCachedSource(source: SourceIndexEntry, showInlineMedia?: (payload: PreviewPayload) => void, inlineOnly = false): Promise<boolean> {
		try {
			const file = this.app.vault.getFileByPath(source.localPath);
			if (!file) return false;
			const preview = previewKindForFile(source.name);
			if (preview.kind === 'unsupported' || file.stat.size > preview.maxBytes) {
				if (inlineOnly) return false;
				await this.openPreviewTab({
					name: source.name,
					kind: 'unsupported',
					message: this.config.language === 'en'
						? `Offline copy is available at ${source.localPath}, but it exceeds the inline preview limit or has an unsupported type.`
						: `离线文件位于 ${source.localPath}，但超过内嵌预览上限或文件类型不受支持。`,
				});
				return true;
			}
			const bytes = new Uint8Array(await this.app.vault.readBinary(file));
			if (bytes.byteLength > preview.maxBytes || await sha256Hex(bytes) !== source.sha256) return false;
			const payload = createPreviewPayload(source.name, preview.kind, bytes, mimeTypeForFile(source.name));
			if (showInlineMedia && (preview.kind === 'image' || preview.kind === 'audio' || preview.kind === 'video')) showInlineMedia(payload);
			else await this.openPreviewTab(payload);
			return true;
		} catch {
			return false;
		}
	}

	private updateSourceIndexPath(_file: TAbstractFile, oldPath: string): void {
		const next = moveSourceIndexPath(this.config.sourceIndex, oldPath, _file.path);
		if (JSON.stringify(next) === JSON.stringify(this.config.sourceIndex)) return;
		this.config.sourceIndex = next;
		void this.persistData();
	}

	async openDashboard(): Promise<void> {
		if (this.unloading) return;
		this.dashboardOpening ??= this.revealDashboard().finally(() => { this.dashboardOpening = undefined; });
		await this.dashboardOpening;
	}

	private async revealDashboard(): Promise<void> {
		try {
			const leaf = await this.ensureDashboardLeaf();
			if (this.unloading) return;
			await this.app.workspace.revealLeaf(leaf);
			if (leaf.view instanceof QuarkDashboardSidebar) {
				this.dashboard = leaf.view;
				void this.refreshDashboard();
			}
		} catch {
			if (this.unloading) return;
			new Notice(this.config.language === 'en' ? 'Could not open the sync sidebar.' : '无法打开夸克同步侧栏。');
		}
	}

	private ensureDashboardLeaf(): Promise<WorkspaceLeaf> {
		const workspace = this.app.workspace;
		const existing = workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE)[0];
		if (existing) return Promise.resolve(existing);
		this.dashboardLeafPending ??= workspace.ensureSideLeaf(DASHBOARD_VIEW_TYPE, 'left', { active: false, reveal: false })
			.finally(() => { this.dashboardLeafPending = undefined; });
		return this.dashboardLeafPending;
	}

	private createDashboardView(leaf: WorkspaceLeaf): QuarkDashboardSidebar {
		const clear = () => {
			if (this.dashboard !== view) return;
			this.dashboard = undefined;
			this.dashboardVault = undefined;
			this.dashboardQuota = undefined;
			this.dashboardQuotaLoading = false;
			this.dashboardPreview = undefined;
			this.dashboardRequest += 1;
		};
		const view = new QuarkDashboardSidebar(leaf, this.dashboardView(), {
			...this.dashboardActions(),
			ready: () => {
				if (this.unloading) return;
				this.dashboard = view;
				queueMicrotask(() => {
					if (this.dashboard === view && !this.dashboardOpening && view.contentEl.isShown()) {
						void this.refreshDashboard();
					}
				});
			},
			close: clear,
		});
		return view;
	}

	private dashboardView(): QuarkDashboardView {
		const { language, autoSync, autoSyncIntervalMinutes, syncOnStartup, lastSummary, lastSyncedAt } = this.config;
		const account = this.accountView;
		const usage = this.dashboardVault ?? summarizeVaultFiles(this.app.vault.getFiles());
		const labels = language === 'en'
			? { notes: 'Notes', images: 'Images', documents: 'Documents', media: 'Audio and video', other: 'Other' }
			: { notes: '笔记', images: '图片', documents: '文档', media: '音视频', other: '其他' };
		return {
			language,
			account: { status: account.state, label: account.state === 'connected' ? account.label : undefined },
			vaultName: this.app.vault.getName(),
			periodicSync: { enabled: autoSync, intervalMinutes: autoSyncIntervalMinutes, syncOnStartup },
			busy: this.busy,
			canEnableAutoSync: this.config.initialSyncCompleted,
			inline: this.dashboardPreview
				? { plan: this.dashboardPreview.plan, confirm: this.dashboardPreview.confirm }
				: undefined,
			skippedDetails: lastSummary?.skipped,
			cloudQuota: account.state === 'connected' ? this.dashboardQuota : undefined,
			quotaLoading: this.dashboardQuotaLoading,
			vault: {
				fileCount: usage.fileCount,
				totalBytes: usage.totalBytes,
				byKind: usage.byKind.map((entry) => ({
					kind: entry.kind, label: labels[entry.kind], files: entry.count, bytes: entry.bytes,
				})),
				largestFiles: usage.largest.map((entry) => ({
					path: entry.path, name: entry.path.split('/').pop() ?? entry.path, bytes: entry.bytes,
				})),
			},
			latestSync: lastSummary ? {
				at: lastSyncedAt ?? undefined,
				uploaded: lastSummary.uploaded,
				downloaded: lastSummary.downloaded,
				deleted: lastSummary.deleted,
				conflicts: lastSummary.conflicts,
				skipped: lastSummary.skipped.length,
			} : undefined,
		};
	}

	private dashboardActions(): QuarkDashboardActions {
		const state = this.accountView.state;
		const mobile = Platform.isMobileApp;
		return {
			refresh: () => this.refreshDashboard(),
			sync: () => this.syncFromDashboard(),
			preview: () => this.previewInDashboard(false),
			confirmSync: () => this.confirmDashboardSync(),
			dismissPlan: () => {
				this.dashboardPreview = undefined;
				this.redrawDashboard();
			},
			checkConnection: () => this.checkConnection(),
			setPeriodicSync: async (enabled) => {
				await this.setAutoSync(enabled);
				this.redrawDashboard();
			},
			setStartupSync: async (enabled) => {
				await this.setSyncOnStartup(enabled);
				this.redrawDashboard();
			},
			settings: () => this.openPluginSettings(),
			login: state !== 'connected' ? () => this.openQrLogin() : undefined,
			exportPairing: !mobile && state === 'connected' ? () => new ExportPairingModal(this.app, this).open() : undefined,
			importPairing: mobile && state !== 'connected' ? () => new ImportPairingModal(this.app, this).open() : undefined,
			logout: state !== 'signed-out' ? () => this.signOut() : undefined,
			openFile: async (path) => {
				const file = this.app.vault.getFileByPath(path);
				if (!file) {
					new Notice(this.config.language === 'en' ? 'This file is no longer in the vault.' : '该文件已不在笔记库中。');
					return;
				}
				const leaf = this.app.workspace.getMostRecentLeaf() ?? this.app.workspace.getLeaf('tab');
				await leaf.openFile(file).catch(() => {
					new Notice(this.config.language === 'en' ? 'Could not open the file.' : '无法打开文件。');
				});
			},
		};
	}

	private openPluginSettings(): void {
		// Older desktop and mobile builds expose the settings controller without public typings.
		const settings = (this.app as App & { setting?: { open?: () => void; openTabById?: (id: string) => void } }).setting;
		if (typeof settings?.open === 'function' && typeof settings.openTabById === 'function') {
			settings.open();
			settings.openTabById(PLUGIN_ID);
		} else {
			new Notice(this.config.language === 'en'
				? 'Open Settings → Community plugins → Quark Note Sync.'
				: '请打开设置 → 第三方插件 → Quark Note Sync。');
		}
	}

	private redrawDashboard(): void {
		if (this.dashboard) this.dashboard.refreshView(this.dashboardView(), this.dashboardActions());
	}

	private async refreshDashboard(refreshLocal = true): Promise<void> {
		if (!this.dashboard || this.unloading) return;
		const request = ++this.dashboardRequest;
		const revision = this.credentialRevision;
		if (refreshLocal) this.dashboardVault = summarizeVaultFiles(this.app.vault.getFiles());
		const cookie = this.accountView.state === 'connected' ? this.readCookie() : null;
		this.dashboardQuotaLoading = cookie !== null;
		this.dashboardQuota = undefined;
		this.redrawDashboard();
		if (!cookie) return;
		try {
			const quota = await this.createClient(cookie).getStorageQuota();
			if (request !== this.dashboardRequest || revision !== this.credentialRevision || !quota) return;
			this.dashboardQuota = { usedBytes: quota.usedBytes, freeBytes: quota.totalBytes - quota.usedBytes };
		} catch {
			// The dashboard can still display local statistics when the quota endpoint is unavailable.
		} finally {
			if (request === this.dashboardRequest) {
				this.dashboardQuotaLoading = false;
				this.redrawDashboard();
			}
		}
	}

	get settingsView(): Pick<PluginSettings, 'language' | 'cloudDirectoryName' | 'deviceName' | 'autoSync' | 'syncOnStartup' | 'autoSyncIntervalMinutes' | 'lastSummary'> {
		return this.config;
	}

	get isBusy(): boolean {
		return this.busy;
	}

	get isFirstSyncComplete(): boolean {
		return this.config.initialSyncCompleted;
	}

	get deviceName(): string {
		return this.config.deviceName;
	}

	get accountView(): AccountView {
		if (!this.savedCookieExists) return { state: 'signed-out' };
		if (this.config.sessionExpired) return { state: 'expired' };
		const id = this.config.boundAccountId;
		const copy = settingsText[this.config.language];
		return {
			state: 'connected',
			label: this.accountNickname ?? (id && id.length > 4 ? copy.accountId + id.slice(-4) : copy.account),
		};
	}

	get savedCookieExists(): boolean {
		return this.readCookie() !== null;
	}

	async saveCookie(value: string): Promise<void> {
		if (this.busy || this.unloading) {
			new Notice('同步运行期间不能修改设置');
			return;
		}
		const cookie = value.trim();
		if (!cookie) {
			await this.signOut();
			return;
		}
		if (/[\r\n]/.test(cookie)) {
			new Notice('Cookie 格式无效，请粘贴单行内容');
			return;
		}
		await this.runExclusive('验证 Cookie', async () => {
			await this.saveValidatedCredential(cookie, this.config.cloudDirectoryName);
			new Notice('Cookie 已验证并安全保存到此设备');
		});
	}

	async signOut(): Promise<void> {
		await this.runExclusive('退出登录', async () => {
			this.app.secretStorage.setSecret(this.credentialId, '');
			this.credentialRevision += 1;
			this.accountNickname = undefined;
			this.dashboardQuota = undefined;
			this.config.sessionExpired = false;
			this.dashboardPreview = undefined;
			this.refreshAutoSyncTimer();
			await this.persistData();
			new Notice('已退出本设备的夸克登录');
		});
	}

	openQrLogin(): void {
		if (this.accountView.state === 'connected') return;
		if (this.busy || this.unloading) {
			new Notice('同步或连接检查运行期间不能开始扫码登录');
			return;
		}
		this.busy = true;
		const modal = new QuarkLoginModal(this.app, new QuarkQrLogin(this.createTransport()), async (cookie, stillCurrent) => {
			await this.saveValidatedCredential(cookie, this.config.cloudDirectoryName, stillCurrent);
			new Notice('夸克账号已连接，网页会话已安全保存到此设备');
		}, () => {
			this.loginModal = undefined;
			this.busy = false;
			if (this.unloading) return;
			this.settingsTab.refreshAccount();
			if (this.dashboard && this.accountView.state === 'connected') void this.refreshDashboard(false);
			else this.redrawDashboard();
			this.runStartupSync();
		});
		this.loginModal = modal;
		modal.open();
	}

	async exportPairingCode(password: string): Promise<string | undefined> {
		return await this.runExclusive('导出授权码', async () => {
			const inspected = await this.inspectCredential(this.requireCookie(), this.config.cloudDirectoryName);
			if (!inspected.rootFid) throw new Error('当前夸克账号下没有此云端目录，请先创建并保存目标目录');
			await this.assertCompatibleLocalState(inspected.accountId, inspected.rootFid);
			this.config.boundAccountId = inspected.accountId;
			this.config.boundRootFid = inspected.rootFid;
			await this.persistData();
			return await createPairingCode({
				cookie: filterPairingCookie(inspected.cookie),
				cloudDirectoryName: this.config.cloudDirectoryName,
				accountId: inspected.accountId,
				rootFid: inspected.rootFid,
			}, password);
		}, true);
	}

	async importPairingCode(code: string, password: string): Promise<boolean> {
		const imported = await this.runExclusive('导入电脑授权', async () => {
			const payload = await readPairingCode(code, password);
			if (!isSafeCloudDirectoryName(payload.cloudDirectoryName) || !isSafeIdentity(payload.accountId) || !isSafeIdentity(payload.rootFid)) {
				throw new Error('授权码中的账号或云端目录信息无效');
			}
			const cookie = filterPairingCookie(payload.cookie);
			const inspected = await this.inspectCredential(cookie, payload.cloudDirectoryName);
			if (inspected.accountId !== payload.accountId || inspected.rootFid !== payload.rootFid) {
				throw new Error('授权码账号或云端目录与夸克当前返回的信息不一致，未更改本机配置');
			}
			await this.saveInspectedCredential(inspected, payload.cloudDirectoryName);
			return true;
		});
		if (imported) new Notice('电脑授权已验证并保存在此设备；请先预览，再手动确认首次同步');
		return imported === true;
	}

	async saveCloudDirectoryName(value: string): Promise<void> {
		if (this.busy || this.unloading) {
			new Notice('同步运行期间不能修改设置');
			return;
		}
		const name = value.trim();
		if (!isSafeCloudDirectoryName(name)) {
			new Notice('请输入安全的单层文件夹名称（不能包含斜线或控制字符）');
			return;
		}
		if (name === this.config.cloudDirectoryName) return;

		const hasLocalSyncState = this.config.initialSyncCompleted ||
			Object.keys(this.config.snapshots).length > 0 ||
			Object.keys(this.config.pendingApplies).length > 0;
		if (!hasLocalSyncState) {
			this.config.cloudDirectoryName = name;
			this.config.boundAccountId = null;
			this.config.boundRootFid = null;
			this.config.autoSync = false;
			this.config.syncOnStartup = false;
			this.config.initialSyncCompleted = false;
			this.config.lastSummary = null;
			await this.persistData();
			new Notice(`云端目录已设为“${name}”`);
			return;
		}

		new ConfirmationModal(
			this.app,
			'更换夸克云端目录？',
			'更换后会清除此库在本设备上的同步快照和待应用记录，并要求重新确认首次同步。旧云端目录和文件不会删除。请在开始新的预览前确认。',
			'清除本地状态并更换',
			async () => {
				if (this.busy || this.unloading) return;
				this.config.cloudDirectoryName = name;
				this.config.boundAccountId = null;
				this.config.boundRootFid = null;
				this.config.snapshots = emptyMap<SyncSnapshot>();
				this.config.pendingApplies = emptyMap<PendingApplyState>();
				this.config.initialSyncCompleted = false;
				this.config.autoSync = false;
				this.config.syncOnStartup = false;
				this.config.lastSummary = null;
				await this.persistData();
				this.refreshAutoSyncTimer();
				new Notice(`已切换到“${name}”；开始新预览前不会变更云端`);
			},
		).open();
	}

	async saveDeviceName(value: string): Promise<void> {
		if (this.busy || this.unloading) {
			new Notice('同步运行期间不能修改设置');
			return;
		}
		const name = value.trim();
		if (!name || name.length > 50 || hasAsciiControl(name)) {
			new Notice('设备名称需为 1 至 50 个字符，且不能包含换行或控制字符');
			return;
		}
		this.config.deviceName = name;
		await this.persistData();
		new Notice('设备名称已保存；同步身份仍使用独立设备 ID');
	}

	async setLanguage(language: string): Promise<boolean> {
		if (this.busy || this.unloading || (language !== 'zh-CN' && language !== 'en')) return false;
		const previous = this.config.language;
		this.config.language = language;
		try {
			await this.persistData();
			return true;
		} catch {
			this.config.language = previous;
			new Notice(settingsText[previous].languageFailed);
			return false;
		}
	}

	async setAutoSync(enabled: boolean): Promise<void> {
		if (this.busy || this.unloading) {
			new Notice('同步运行期间不能修改设置');
			return;
		}
		if (enabled && !this.config.initialSyncCompleted) {
			new Notice('请先手动确认并完成首次同步');
			return;
		}
		this.config.autoSync = enabled;
		await this.persistData();
		this.refreshAutoSyncTimer();
		new Notice(enabled ? `自动同步已开启（每 ${this.config.autoSyncIntervalMinutes} 分钟）` : '自动同步已关闭');
	}

	async setSyncOnStartup(enabled: boolean): Promise<void> {
		if (this.busy || this.unloading) {
			new Notice('同步运行期间不能修改设置');
			return;
		}
		if (enabled && !this.config.initialSyncCompleted) {
			new Notice('请先手动确认并完成首次同步');
			return;
		}
		const previous = this.config.syncOnStartup;
		this.config.syncOnStartup = enabled;
		try {
			await this.persistData();
		} catch {
			this.config.syncOnStartup = previous;
			new Notice('保存启动同步设置失败');
		}
	}

	async setAutoSyncInterval(value: number): Promise<void> {
		if (this.busy || this.unloading) {
			new Notice('同步运行期间不能修改设置');
			return;
		}
		if (!Number.isFinite(value) || value < 1 || value > 1440) {
			new Notice('间隔请输入 1 至 1440 分钟');
			return;
		}
		this.config.autoSyncIntervalMinutes = Math.floor(value);
		await this.persistData();
		this.refreshAutoSyncTimer();
		new Notice(`自动同步间隔已设为 ${this.config.autoSyncIntervalMinutes} 分钟`);
	}

	private readSyncPreview(firstSync: boolean): Promise<SyncPlan | undefined> {
		return this.runExclusive(firstSync ? '读取首次同步预览' : '读取同步预览', async () => {
			return await this.createService(this.requireCookie()).preview();
		}, true);
	}

	private async previewInDashboard(confirm: boolean): Promise<void> {
		const dashboard = this.dashboard;
		if (!dashboard || this.busy || this.unloading) return;
		const directory = this.config.cloudDirectoryName;
		const credentialRevision = this.credentialRevision;
		this.dashboardPreview = undefined;
		const plan = await this.readSyncPreview(confirm);
		if (!plan || this.dashboard !== dashboard || this.unloading) return;
		this.dashboardPreview = { plan, confirm, directory, credentialRevision };
		this.redrawDashboard();
	}

	private async syncFromDashboard(): Promise<void> {
		if (this.busy || this.unloading) return;
		if (!this.config.initialSyncCompleted) {
			await this.previewInDashboard(true);
			return;
		}
		this.dashboardPreview = undefined;
		const summary = await this.performSync(false, false, false);
		if (summary) void this.refreshDashboard(false);
	}

	private async confirmDashboardSync(): Promise<void> {
		const preview = this.dashboardPreview;
		if (!preview?.confirm || this.busy || this.unloading) return;
		this.dashboardPreview = undefined;
		if (!this.isCurrentSyncPreview(preview.directory, preview.credentialRevision)) {
			this.redrawDashboard();
			return;
		}
		const summary = await this.performSync(!this.config.initialSyncCompleted, false, false);
		if (summary) void this.refreshDashboard(false);
	}

	private isCurrentSyncPreview(directory: string, credentialRevision: number): boolean {
		if (directory === this.config.cloudDirectoryName && credentialRevision === this.credentialRevision) return true;
		new Notice(this.config.language === 'en'
			? 'The cloud folder or session changed. Preview again before syncing.'
			: '云端目录或登录状态已更改，请重新预览后再同步。');
		return false;
	}

	async previewSync(): Promise<void> {
		const plan = await this.readSyncPreview(false);
		if (plan && !this.unloading) new PlanModal(this.app, plan, false).open();
	}

	async requestSync(): Promise<void> {
		if (this.config.initialSyncCompleted) {
			await this.performSync(false);
			return;
		}
		const directory = this.config.cloudDirectoryName;
		const credentialRevision = this.credentialRevision;
		const plan = await this.readSyncPreview(true);
		if (!plan || this.unloading) return;
		new PlanModal(this.app, plan, true, () => {
			if (this.isCurrentSyncPreview(directory, credentialRevision)) void this.performSync(true);
		}).open();
	}

	private async performSync(confirmedInitialSync: boolean, automatic = false, showSummary = true): Promise<SyncSummary | undefined> {
		if (this.unloading || (automatic && !this.canRunAutomaticSync())) return;
		if (!this.config.initialSyncCompleted && !confirmedInitialSync) {
			await this.requestSync();
			return;
		}
		const summary = await this.runExclusive('同步', async () => {
			const cookie = this.requireCookie();
			const client = this.createClient(cookie);
			const result = sanitizeSummary(await this.createService(cookie, client).sync(), cookie);
			if (!this.unloading) {
				const currentAccountId = this.config.boundAccountId ?? await client.checkConnection();
				const root = await client.findRootFolder(this.config.cloudDirectoryName);
				if (currentAccountId && root) {
					this.config.boundAccountId = currentAccountId;
					this.config.boundRootFid = root.fid;
				}
				if (client.sessionCookie !== cookie) {
					this.app.secretStorage.setSecret(this.credentialId, client.sessionCookie);
					this.credentialRevision += 1;
				}
				this.config.lastSummary = result;
				this.config.lastSyncedAt = Date.now();
				if (this.dashboard) this.dashboardVault = summarizeVaultFiles(this.app.vault.getFiles());
				if (confirmedInitialSync) this.config.initialSyncCompleted = true;
				await this.persistData();
				if (confirmedInitialSync) this.refreshAutoSyncTimer();
			}
			return result;
		}, true);
		if (summary && !this.unloading && !automatic && showSummary) new SyncSummaryModal(this.app, summary).open();
		return summary;
	}

	showLastSummary(): void {
		if (this.config.lastSummary) new SyncSummaryModal(this.app, this.config.lastSummary).open();
		else new Notice('还没有同步记录');
	}

	async checkConnection(): Promise<void> {
		await this.runExclusive('检查连接', async () => {
			const cookie = this.requireCookie();
			const client = this.createClient(cookie);
			const account = await client.checkAccount();
			if (this.unloading) return;
			this.accountNickname = account.nickname;
			if (client.sessionCookie !== cookie) this.storeSession(client.sessionCookie, account.nickname);
			new Notice('夸克连接正常');
		}, true);
	}

	private async saveValidatedCredential(cookie: string, directoryName: string, shouldContinue: () => boolean = () => true): Promise<void> {
		if (!shouldContinue()) throw new Error('二维码登录已取消，未保存会话');
		const inspected = await this.inspectCredential(cookie, directoryName);
		await this.saveInspectedCredential(inspected, directoryName, shouldContinue);
	}

	private async saveInspectedCredential(
		inspected: InspectedCredential,
		directoryName: string,
		shouldContinue: () => boolean = () => true,
	): Promise<void> {
		if (this.unloading || !shouldContinue()) throw new Error('登录已取消，未保存会话');
		const hadLocalState = this.hasLocalSyncState();
		const previousConfig = this.config;
		this.config = { ...previousConfig };
		try {
			await this.assertCompatibleLocalState(inspected.accountId, inspected.rootFid, shouldContinue);
		} catch (error) {
			this.config = previousConfig;
			throw error;
		}
		if (!shouldContinue()) {
			this.config = previousConfig;
			throw new Error('二维码登录已取消，未保存会话');
		}
		if (!hadLocalState) {
			this.config.snapshots = emptyMap<SyncSnapshot>();
			this.config.pendingApplies = emptyMap<PendingApplyState>();
			this.config.initialSyncCompleted = false;
			this.config.autoSync = false;
			this.config.syncOnStartup = false;
			this.config.lastSummary = null;
		}
		this.config.cloudDirectoryName = directoryName;
		this.config.boundAccountId = inspected.accountId;
		this.config.boundRootFid = inspected.rootFid ?? null;
		this.config.sessionExpired = false;
		try {
			await this.persistData();
		} catch (error) {
			this.config = previousConfig;
			throw error;
		}
		if (!shouldContinue()) {
			this.config = previousConfig;
			await this.persistData();
			throw new Error('二维码登录已取消，未保存会话');
		}
		if (this.unloading) return;
		this.storeSession(inspected.cookie, inspected.nickname);
	}

	private storeSession(cookie: string, nickname: string | undefined): void {
		this.app.secretStorage.setSecret(this.credentialId, cookie);
		this.credentialRevision += 1;
		this.accountNickname = nickname;
		this.refreshAutoSyncTimer();
	}

	private async inspectCredential(cookie: string, directoryName: string): Promise<InspectedCredential> {
		const client = this.createClient(cookie);
		const { accountId, nickname } = await client.checkAccount();
		if (!accountId) throw new Error('夸克连接正常，但无法确认账号标识；未保存登录凭据');
		const root = await client.findRootFolder(directoryName);
		return { accountId, rootFid: root?.fid, cookie: client.sessionCookie, nickname };
	}

	private async assertCompatibleLocalState(accountId: string, rootFid: string | undefined, shouldContinue: () => boolean = () => true): Promise<boolean> {
		if (!shouldContinue()) throw new Error('操作已取消');
		if (!this.hasLocalSyncState()) return false;
		if (this.config.boundAccountId && !this.config.boundRootFid) {
			if (this.config.boundAccountId !== accountId || !rootFid) {
				throw new Error('此设备已有同步历史，账号或云端目录不一致；为保护本地同步状态，未替换凭据');
			}
			this.config.boundRootFid = rootFid;
			return true;
		}
		if (this.config.boundAccountId || this.config.boundRootFid) {
			if (this.config.boundAccountId !== accountId || this.config.boundRootFid !== rootFid) {
				throw new Error('此设备已有同步历史，账号或云端目录不一致；为保护本地同步状态，未替换凭据');
			}
			return true;
		}
		const currentCookie = this.readCookie();
		if (!currentCookie) throw new Error('此设备已有同步历史，但无法验证原账号和目录；为保护本地状态，未替换凭据');
		try {
			const existing = await this.inspectCredential(currentCookie, this.config.cloudDirectoryName);
			if (!shouldContinue()) throw new Error('操作已取消');
			if (existing.accountId === accountId && existing.rootFid === rootFid) return true;
		} catch {
			// A failed old session cannot prove that this is the same account and target.
		}
		throw new Error('此设备已有同步历史，无法确认它与新账号和云端目录相同；为保护本地状态，未替换凭据');
	}

	private hasLocalSyncState(): boolean {
		return this.config.initialSyncCompleted ||
			Object.keys(this.config.snapshots).length > 0 ||
			Object.keys(this.config.pendingApplies).length > 0;
	}

	private createService(cookie: string, client = this.createClient(cookie)): QuarkSyncService {
		return new QuarkSyncService(this.app, client, this.config, {
			deviceId: this.config.deviceId,
			snapshots: this.config.snapshots,
			pendingApplies: this.config.pendingApplies,
			sourceIndex: this.config.sourceIndex,
			persist: async () => {
				if (this.unloading) throw new Error('插件已卸载，已停止后续同步操作');
				await this.persistData();
			},
		});
	}

	private createClient(cookie: string): QuarkClient {
		const transport = this.createTransport();
		return new QuarkClient({
			request: async (request: HttpRequest): Promise<HttpResponse> => {
				if (this.unloading) throw new Error('插件已卸载，已停止后续夸克请求');
				return await transport.request(request);
			},
		}, cookie);
	}

	private createTransport(): QuarkTransport {
		if (Platform.isIosApp) return new QuarkTransport('ios');
		if (Platform.isAndroidApp) return new QuarkTransport('android');
		return new QuarkTransport(Platform.isMobileApp ? 'mobile' : 'desktop');
	}

	private requireCookie(): string {
		if (this.unloading) throw new Error('插件已卸载');
		const cookie = this.readCookie();
		if (!cookie) throw new Error('请先在“夸克账号”栏登录');
		if (this.config.sessionExpired) throw new Error('夸克登录已失效，请重新登录');
		return cookie;
	}

	private readCookie(): string | null {
		try {
			const secret = this.app.secretStorage.getSecret(this.credentialId);
			return secret?.trim() ? secret : null;
		} catch {
			return null;
		}
	}

	private async runExclusive<T>(label: string, operation: () => Promise<T>, usesSavedSession = false): Promise<T | undefined> {
		if (this.unloading) return undefined;
		if (this.busy) {
			new Notice('已有预览或同步正在运行，请等待完成');
			return undefined;
		}
		this.busy = true;
		const previousAccount = this.accountView;
		try {
			this.redrawDashboard();
			return await operation();
		} catch (error) {
			if (!this.unloading) {
				if (usesSavedSession && error instanceof QuarkAuthenticationError) {
					this.config.sessionExpired = true;
					this.refreshAutoSyncTimer();
					try {
						await this.persistData();
					} catch {
						new Notice('无法保存夸克登录状态');
					}
				}
				new Notice(label + '失败：' + this.safeError(error));
			}
			return undefined;
		} finally {
			this.busy = false;
			const currentAccount = this.accountView;
			if (previousAccount.state !== currentAccount.state ||
				(previousAccount.state === 'connected' && currentAccount.state === 'connected' &&
					previousAccount.label !== currentAccount.label)) {
				this.settingsTab.refreshAccount();
			}
			if (this.dashboard && previousAccount.state !== 'connected' && currentAccount.state === 'connected') {
				void this.refreshDashboard(false);
			} else {
				this.redrawDashboard();
			}
			this.runStartupSync();
		}
	}

	private safeError(error: unknown): string {
		let message = error instanceof Error ? error.message : '操作失败';
		const cookie = this.readCookie();
		if (cookie) message = message.split(cookie).join('[Cookie 已隐藏]');
		return message.replace(/((?:cookie|authorization)\s*[:=]\s*)[^\s;,]+/gi, '$1[已隐藏]');
	}

	private runStartupSync(): void {
		if (!this.layoutReady || !this.startupSyncPending || this.busy) return;
		this.startupSyncPending = false;
		if (this.config.syncOnStartup && this.canRunAutomaticSync()) void this.performSync(false, true);
	}

	private canRunAutomaticSync(): boolean {
		return !this.unloading && !this.busy && this.config.initialSyncCompleted &&
			!this.config.sessionExpired && this.savedCookieExists;
	}

	private refreshAutoSyncTimer(): void {
		if (this.autoSyncTimer !== undefined) {
			window.clearInterval(this.autoSyncTimer);
			this.autoSyncTimer = undefined;
		}
		if (this.unloading || !this.config.autoSync || !this.config.initialSyncCompleted ||
			this.config.sessionExpired || !this.savedCookieExists) return;
		this.autoSyncTimer = window.setInterval(() => {
			void this.performSync(false, true);
		}, this.config.autoSyncIntervalMinutes * 60_000);
	}

	private async persistData(): Promise<void> {
		if (this.unloading) return;
		await this.saveData({
			language: this.config.language,
			cloudDirectoryName: this.config.cloudDirectoryName,
			deviceName: this.config.deviceName,
			autoSync: this.config.autoSync,
			syncOnStartup: this.config.syncOnStartup,
			sessionExpired: this.config.sessionExpired,
			autoSyncIntervalMinutes: this.config.autoSyncIntervalMinutes,
			initialSyncCompleted: this.config.initialSyncCompleted,
			lastSummary: this.config.lastSummary,
			lastSyncedAt: this.config.lastSyncedAt,
			deviceId: this.config.deviceId,
			boundAccountId: this.config.boundAccountId,
			boundRootFid: this.config.boundRootFid,
			snapshots: this.config.snapshots,
			pendingApplies: this.config.pendingApplies,
			sourceIndex: this.config.sourceIndex,
		});
	}
}

interface QuarkSettingRow {
	name: string;
	desc?: string;
	render: (setting: Setting) => void | (() => void);
}

class QuarkSettingsTab extends PluginSettingTab {
	private readonly plugin: QuarkNoteSyncPlugin;
	private accountRow: Setting | undefined;

	constructor(app: App, plugin: QuarkNoteSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		this.renderLegacySettings();
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const { language } = this.plugin.settingsView;
		const copy = settingsText[language];
		return [...this.getSettingsRows(), { type: 'page', name: copy.advanced, items: [this.getCookieSetting()] }];
	}

	private renderLegacySettings(): void {
		const { containerEl } = this;
		containerEl.empty();
		for (const item of this.getSettingsRows()) this.renderLegacyRow(containerEl, item);
		const advanced = containerEl.createEl('details');
		advanced.createEl('summary', { text: settingsText[this.plugin.settingsView.language].advanced });
		this.renderLegacyRow(advanced, this.getCookieSetting());
	}

	private renderLegacyRow(container: HTMLElement, item: QuarkSettingRow): void {
		const row = new Setting(container).setName(item.name);
		if (item.desc) row.setDesc(item.desc);
		item.render(row);
	}

	private getSettingsRows(): QuarkSettingRow[] {
		const { language, lastSummary: last } = this.plugin.settingsView;
		const copy = settingsText[language];
		return [
			{
				name: copy.title,
				render: (row) => {
					row.setHeading();
				},
			},
			{
				name: language === 'en' ? 'Open sync dashboard' : '打开同步面板',
				render: (row) => {
					row.addButton((button) => button
						.setButtonText(language === 'en' ? 'Open' : '打开')
						.onClick(() => void this.plugin.openDashboard()));
				},
			},
			{
				name: '语言 / Language',
				render: (row) => {
					row.addDropdown((dropdown) => dropdown
						.addOption('zh-CN', '简体中文')
						.addOption('en', 'English')
						.setValue(language)
						.onChange(async (value) => {
							dropdown.setDisabled(true);
							const changed = await this.plugin.setLanguage(value);
							if (changed && this.accountRow) {
								if (requireApiVersion('1.13.0')) this.update();
								else this.renderLegacySettings();
							}
							else dropdown.setValue(this.plugin.settingsView.language).setDisabled(false);
						}));
				},
			},
			{
				name: copy.account,
				render: (row) => {
					this.accountRow = row;
					this.renderAccount(row);
					return () => {
						if (this.accountRow === row) this.accountRow = undefined;
					};
				},
			},
			{
				name: copy.cloudFolder,
				desc: copy.cloudFolderHelp,
				render: (row) => {
					let cloudInput!: TextComponent;
					row.addText((text) => {
						cloudInput = text;
						text.setValue(this.plugin.settingsView.cloudDirectoryName);
						text.setPlaceholder(DEFAULT_CLOUD_DIRECTORY);
						text.setDisabled(this.plugin.isBusy);
						})
						.addButton((button) => button
						.setButtonText(copy.save)
						.setDisabled(this.plugin.isBusy)
						.onClick(() => void this.plugin.saveCloudDirectoryName(cloudInput.getValue())));
				},
			},
			{
				name: copy.deviceName,
				desc: copy.deviceHelp,
				render: (row) => {
					let deviceInput!: TextComponent;
					row.addText((text) => {
						deviceInput = text;
						text.setValue(this.plugin.settingsView.deviceName);
						text.setPlaceholder(copy.deviceExample);
						text.setDisabled(this.plugin.isBusy);
						})
						.addButton((button) => button
						.setButtonText(copy.save)
						.setDisabled(this.plugin.isBusy)
						.onClick(() => void this.plugin.saveDeviceName(deviceInput.getValue())));
				},
			},
			{
				name: copy.periodic,
				desc: this.plugin.isFirstSyncComplete ? copy.periodicHelp : copy.firstSyncRequired,
				render: (row) => {
					row.addToggle((toggle) => toggle
						.setValue(this.plugin.settingsView.autoSync)
						.setDisabled(this.plugin.isBusy || !this.plugin.isFirstSyncComplete)
						.onChange((value) => void this.plugin.setAutoSync(value)));
				},
			},
			{
				name: copy.startup,
				desc: this.plugin.isFirstSyncComplete ? copy.startupHelp : copy.firstSyncRequired,
				render: (row) => {
					row.addToggle((toggle) => toggle
						.setValue(this.plugin.settingsView.syncOnStartup)
						.setDisabled(this.plugin.isBusy || !this.plugin.isFirstSyncComplete)
						.onChange(async (enabled) => {
							await this.plugin.setSyncOnStartup(enabled);
							toggle.setValue(this.plugin.settingsView.syncOnStartup);
						}));
				},
			},
			{
				name: copy.interval,
				desc: copy.intervalHelp,
				render: (row) => {
					let intervalInput!: TextComponent;
					row.addText((text) => {
						intervalInput = text;
						text.inputEl.type = 'number';
						text.inputEl.min = '1';
						text.inputEl.max = '1440';
						text.setValue(String(this.plugin.settingsView.autoSyncIntervalMinutes));
						text.setDisabled(this.plugin.isBusy);
						})
						.addButton((button) => button
						.setButtonText(copy.save)
						.setDisabled(this.plugin.isBusy)
						.onClick(() => void this.plugin.setAutoSyncInterval(Number(intervalInput.getValue()))));
				},
			},
			{
				name: copy.sync,
				desc: copy.syncHelp,
				render: (row) => {
					row.addButton((button) => button
						.setButtonText(copy.preview)
						.setDisabled(this.plugin.isBusy)
						.onClick(() => void this.plugin.previewSync()))
						.addButton((button) => button
						.setButtonText(copy.syncNow)
						.setCta()
						.setDisabled(this.plugin.isBusy)
						.onClick(() => void this.plugin.requestSync()));
				},
			},
			{
				name: copy.details,
				desc: last
					? language === 'en'
						? `Last sync: ${last.uploaded} uploaded, ${last.downloaded} downloaded, ${last.deleted} deleted, ${last.conflicts} conflicts, ${last.skipped.length} skipped`
						: `上次同步：上传 ${last.uploaded}，下载 ${last.downloaded}，删除 ${last.deleted}，冲突 ${last.conflicts}，跳过 ${last.skipped.length}`
					: copy.noSummary,
				render: (row) => {
					row.addButton((button) => button
						.setButtonText(copy.viewDetails)
						.setDisabled(this.plugin.isBusy || !last)
						.onClick(() => this.plugin.showLastSummary()));
				},
			},
			{
				name: copy.connection,
				desc: copy.connectionHelp,
				render: (row) => {
					row.addButton((button) => button
						.setButtonText(copy.checkConnection)
						.setDisabled(this.plugin.isBusy)
						.onClick(() => void this.plugin.checkConnection()));
				},
			},
		];
	}

	private getCookieSetting(): QuarkSettingRow {
		const copy = settingsText[this.plugin.settingsView.language];
		return {
			name: copy.cookie,
			desc: copy.cookieHelp,
			render: (row) => {
				let cookieInput!: TextComponent;
				row.addText((text) => {
						cookieInput = text;
						text.inputEl.type = 'password';
						text.inputEl.autocomplete = 'off';
						text.inputEl.setAttribute('autocapitalize', 'off');
						text.inputEl.setAttribute('spellcheck', 'false');
						text.setPlaceholder(this.plugin.savedCookieExists ? copy.cookieSaved : copy.cookieEmpty);
						text.setDisabled(this.plugin.isBusy);
					})
					.addButton((button) => button
						.setButtonText(copy.saveCookie)
						.setDisabled(this.plugin.isBusy)
						.onClick(async () => {
							await this.plugin.saveCookie(cookieInput.getValue());
							cookieInput.setValue('');
							cookieInput.setPlaceholder(this.plugin.savedCookieExists ? copy.cookieSaved : copy.cookieEmpty);
						}));
			},
		};
	}

	hide(): void {
		this.accountRow = undefined;
	}

	refreshAccount(): void {
		const row = this.accountRow;
		if (!row) return;
		row.clear();
		this.renderAccount(row);
	}

	private renderAccount(row: Setting): void {
		const copy = settingsText[this.plugin.settingsView.language];
		const account = this.plugin.accountView;
		if (account.state === 'connected') {
			row.setDesc(copy.signedIn + account.label);
			if (Platform.isDesktopApp && !Platform.isMobileApp) {
				row.addButton((button) => button
					.setButtonText(copy.exportAuthorization)
					.setDisabled(this.plugin.isBusy)
					.onClick(() => new ExportPairingModal(this.app, this.plugin).open()));
			}
		} else {
			row.setDesc(account.state === 'expired' ? copy.expired : copy.signedOut);
			if (Platform.isDesktopApp || Platform.isMobileApp) {
				row.addButton((button) => button
					.setButtonText(copy.qrSignIn)
					.setCta()
					.setDisabled(this.plugin.isBusy)
					.onClick(() => this.plugin.openQrLogin()));
			}
			if (Platform.isMobileApp) {
				row.addButton((button) => button
					.setButtonText(copy.importAuthorization)
					.setDisabled(this.plugin.isBusy)
					.onClick(() => new ImportPairingModal(this.app, this.plugin).open()));
			}
		}
		if (account.state !== 'signed-out') {
			row.addButton((button) => button
				.setButtonText(copy.signOut)
				.setDisabled(this.plugin.isBusy)
				.onClick(() => this.plugin.signOut()));
		}
	}
}

class QuarkLoginModal extends Modal {
	private readonly login: QuarkQrLogin;
	private readonly onAuthorized: (cookie: string, stillCurrent: () => boolean) => Promise<void>;
	private readonly onClosed: () => void;
	private statusEl!: HTMLElement;
	private qrEl!: HTMLElement;
	private refreshButton!: HTMLButtonElement;
	private cancelButton!: HTMLButtonElement;
	private session: QuarkQrSession | undefined;
	private pollTimer: number | undefined;
	private generation = 0;
	private polling = false;
	private committing = false;
	private closed = false;
	private readonly pollWhenVisible = () => {
		if (this.contentEl.ownerDocument.visibilityState === 'visible') void this.poll();
	};

	constructor(app: App, login: QuarkQrLogin, onAuthorized: (cookie: string, stillCurrent: () => boolean) => Promise<void>, onClosed: () => void) {
		super(app);
		this.login = login;
		this.onAuthorized = onAuthorized;
		this.onClosed = onClosed;
	}

	onOpen(): void {
		this.setTitle('夸克网页扫码登录');
		this.contentEl.empty();
		this.contentEl.createEl('p', {
			text: Platform.isMobileApp
				? '同一台手机登录时，先截取下方二维码，再到夸克 App 的「扫一扫」选择相册图片（如果有此入口）并确认。也可用另一台设备扫码。确认后回到 Obsidian，保留此登录窗口。'
				: '请使用自己的夸克 App 扫描下方二维码，并在手机中确认登录。',
		});
		this.contentEl.ownerDocument.addEventListener('visibilitychange', this.pollWhenVisible);
		this.qrEl = this.contentEl.createDiv({ cls: 'quark-login-qr' });
		this.statusEl = this.contentEl.createEl('p', { text: '正在向夸克申请二维码…' });
		const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' });
		this.refreshButton = buttons.createEl('button', { text: '刷新二维码' });
		this.refreshButton.disabled = true;
		this.refreshButton.addEventListener('click', () => void this.refreshQr());
		this.cancelButton = buttons.createEl('button', { text: '取消' });
		this.cancelButton.addEventListener('click', () => this.close());
		void this.refreshQr();
	}

	onClose(): void {
		if (this.closed) return;
		this.closed = true;
		this.contentEl.ownerDocument.removeEventListener('visibilitychange', this.pollWhenVisible);
		this.stopPolling();
		this.qrEl?.empty();
		if (!this.committing) this.onClosed();
	}

	private async refreshQr(): Promise<void> {
		if (this.committing || this.closed) return;
		this.stopPolling();
		const currentGeneration = ++this.generation;
		this.session = undefined;
		this.qrEl.empty();
		this.refreshButton.disabled = true;
		this.statusEl.setText('正在向夸克申请二维码…');
		try {
			const session = await this.login.createSession();
			if (this.closed || currentGeneration !== this.generation) return;
			const image = this.qrEl.createEl('img', { attr: { alt: '夸克网页登录二维码', width: '260', height: '260' } });
			image.src = await QRCode.toDataURL(session.qrUrl, { width: 260, margin: 4, errorCorrectionLevel: 'M' });
			if (this.closed || currentGeneration !== this.generation) return;
			this.session = session;
			this.statusEl.setText('等待手机扫码并确认登录…二维码约 5 分钟后过期。');
			this.refreshButton.disabled = false;
			this.pollTimer = window.setInterval(() => void this.poll(), 2000);
		} catch (error) {
			if (this.closed || currentGeneration !== this.generation) return;
			this.statusEl.setText(`二维码创建失败：${safeModalError(error)}`);
			this.refreshButton.disabled = false;
		}
	}

	private async poll(): Promise<void> {
		const session = this.session;
		if (this.closed || this.committing || !session || this.polling) return;
		if (Date.now() >= session.expiresAt) {
			this.stopPolling();
			this.statusEl.setText('二维码已过期，请刷新后重试。');
			return;
		}
		this.polling = true;
		const currentGeneration = this.generation;
		try {
			const result = await this.login.poll(session);
			if (!this.isCurrent(session, currentGeneration)) return;
			if (result.state === 'pending') return;
			this.stopPolling();
			if (result.state === 'expired') {
				this.statusEl.setText('二维码已过期，请刷新后重试。');
				return;
			}
			if (result.state === 'cancelled') {
				this.statusEl.setText('手机端取消了登录。你可以刷新二维码重新开始。');
				return;
			}
			this.committing = true;
			this.refreshButton.disabled = true;
			this.cancelButton.disabled = true;
			this.statusEl.setText('手机已确认，正在验证账号和夸克目录…');
			const cookie = await this.login.exchangeTicket(result.serviceTicket);
			if (!this.isCurrent(session, currentGeneration)) return;
			await this.onAuthorized(cookie, () => this.isCurrent(session, currentGeneration));
			if (!this.isCurrent(session, currentGeneration)) return;
			if (!this.closed) this.close();
		} catch (error) {
			if (!this.closed) {
				this.committing = false;
				this.cancelButton.disabled = false;
				this.statusEl.setText(`登录未完成：${safeModalError(error)}`);
				this.refreshButton.disabled = false;
			}
		} finally {
			this.polling = false;
			if (this.closed && this.committing) {
				this.committing = false;
				this.onClosed();
			}
		}
	}

	private isCurrent(session: QuarkQrSession, generation: number): boolean {
		return !this.closed && this.session === session && this.generation === generation;
	}

	private stopPolling(): void {
		if (this.pollTimer !== undefined) {
			window.clearInterval(this.pollTimer);
			this.pollTimer = undefined;
		}
	}
}

class ExportPairingModal extends Modal {
	private readonly plugin: QuarkNoteSyncPlugin;

	constructor(app: App, plugin: QuarkNoteSyncPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen(): void {
		this.setTitle('导出到手机');
		this.contentEl.empty();
		this.contentEl.createEl('p', { text: '生成仅在本机加密的授权码。授权码包含夸克登录会话和已验证的云端目录，不含笔记或同步历史；15 分钟内可导入。' });
		this.contentEl.createEl('p', { text: '请设置至少 12 位的独立密码，并通过另一种安全方式把密码交给自己的手机。插件不会上传授权码或密码。' });
		const password = this.contentEl.createEl('input', { attr: { type: 'password', autocomplete: 'new-password', placeholder: '授权密码（至少 12 位）' } });
		password.setAttribute('autocapitalize', 'off');
		password.setAttribute('spellcheck', 'false');
		const confirmation = this.contentEl.createEl('input', { attr: { type: 'password', autocomplete: 'new-password', placeholder: '再次输入授权密码' } });
		confirmation.setAttribute('autocapitalize', 'off');
		confirmation.setAttribute('spellcheck', 'false');
		const status = this.contentEl.createEl('p', { text: '' });
		const code = this.contentEl.createEl('textarea', { cls: 'quark-note-sync-pairing-code', attr: { rows: '7', readonly: 'true', 'aria-label': '加密授权码' } });
		code.hidden = true;
		const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' });
		const generate = buttons.createEl('button', { text: '生成授权码', cls: 'mod-cta' });
		const english = this.plugin.settingsView.language === 'en';
		const selectCode = buttons.createEl('button', { text: english ? 'Select authorization code' : '选择授权码' });
		selectCode.disabled = true;
		selectCode.addEventListener('click', () => {
			code.focus();
			code.select();
			status.setText(english ? 'Code selected. Use your system copy command and share the password separately.' : '授权码已选中，请用系统复制命令。密码仍需单独传给手机。');
		});
		buttons.createEl('button', { text: '关闭' }).addEventListener('click', () => this.close());
		const generateCode = async () => {
			if (password.value !== confirmation.value) {
				status.setText('两次输入的密码不一致。');
				return;
			}
			generate.disabled = true;
			status.setText('正在验证夸克账号和目标目录并生成授权码…');
			try {
				const result = await this.plugin.exportPairingCode(password.value);
				if (!result) {
					status.setText('授权码未生成；请检查上方提示。');
					return;
				}
				password.value = '';
				confirmation.value = '';
				code.value = result;
				code.hidden = false;
				selectCode.disabled = false;
				status.setText('授权码已生成。请在 15 分钟内导入手机；密码不会保存。');
			} finally {
				generate.disabled = false;
			}
		};
		generate.addEventListener('click', () => void generateCode());
	}
}

class ImportPairingModal extends Modal {
	private readonly plugin: QuarkNoteSyncPlugin;

	constructor(app: App, plugin: QuarkNoteSyncPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen(): void {
		this.setTitle('导入电脑授权');
		this.contentEl.empty();
		this.contentEl.createEl('p', { text: '粘贴 Windows 端生成的加密授权码，再输入相同密码。导入会验证夸克账号和云端目录；不会自动开始同步。' });
		const code = this.contentEl.createEl('textarea', { cls: 'quark-note-sync-pairing-code', attr: { rows: '7', placeholder: '粘贴 QPS1 开头的授权码', 'aria-label': '加密授权码' } });
		code.setAttribute('autocapitalize', 'off');
		code.setAttribute('spellcheck', 'false');
		const password = this.contentEl.createEl('input', { attr: { type: 'password', autocomplete: 'off', placeholder: '授权密码' } });
		password.setAttribute('autocapitalize', 'off');
		password.setAttribute('spellcheck', 'false');
		const status = this.contentEl.createEl('p', { text: '' });
		const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' });
		const importButton = buttons.createEl('button', { text: '验证并导入', cls: 'mod-cta' });
		buttons.createEl('button', { text: '取消' }).addEventListener('click', () => this.close());
		const importCode = async () => {
			if (!code.value.trim() || !password.value) {
				status.setText('请填写授权码和密码。');
				return;
			}
			importButton.disabled = true;
			status.setText('正在解密授权码并验证夸克账号和目录…');
			try {
				const imported = await this.plugin.importPairingCode(code.value, password.value);
				if (imported) this.close();
				else status.setText('授权未导入；请检查上方提示。');
			} finally {
				password.value = '';
				importButton.disabled = false;
			}
		};
		importButton.addEventListener('click', () => void importCode());
	}
}

class PlanModal extends Modal {
	private readonly plan: SyncPlan;
	private readonly confirmInitial: boolean;
	private readonly onConfirm?: () => void;

	constructor(app: App, plan: SyncPlan, confirmInitial: boolean, onConfirm?: () => void) {
		super(app);
		this.plan = plan;
		this.confirmInitial = confirmInitial;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		this.setTitle(this.confirmInitial ? '首次同步预览' : '同步预览');
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('p', {
			text: this.confirmInitial
				? '以下预览只读取本地和云端内容。确认后才会开始首次同步，并可能创建云端同步目录。'
				: '这是只读预览；此操作没有写入本地或云端文件。',
		});
		contentEl.createEl('p', { text: `待发布版本：${this.plan.events.length}；待检查路径：${this.plan.paths.length}；跳过：${this.plan.skipped.length}` });
		const changes = this.plan.paths.map((item) => {
			const action = item.result.deleted ? '远端为删除版本' : item.result.winner ? '检查/应用远端版本' : '无最终版本';
			const conflictCount = item.result.conflictCopies.length;
			return `${item.path} — ${action}${conflictCount ? `；冲突副本 ${conflictCount} 个` : ''}`;
		});
		appendList(contentEl, '计划路径', changes);
		appendList(contentEl, '跳过路径', this.plan.skipped.map((item) => `${item.path} — ${item.reason}`));
		const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
		const cancel = buttons.createEl('button', { text: this.confirmInitial ? '取消' : '关闭' });
		cancel.addEventListener('click', () => this.close());
		if (this.confirmInitial) {
			const confirm = buttons.createEl('button', { text: '确认并开始首次同步', cls: 'mod-cta' });
			confirm.addEventListener('click', () => {
				this.close();
				this.onConfirm?.();
			});
		}
	}
}

class SyncSummaryModal extends Modal {
	private readonly summary: SyncSummary;

	constructor(app: App, summary: SyncSummary) {
		super(app);
		this.summary = summary;
	}

	onOpen(): void {
		this.setTitle('同步状态');
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('p', {
			text: `已上传 ${this.summary.uploaded}，已下载 ${this.summary.downloaded}，已删除 ${this.summary.deleted}，冲突副本 ${this.summary.conflicts}，跳过 ${this.summary.skipped.length}。`,
		});
		appendList(contentEl, '跳过路径及原因', this.summary.skipped.map((item) => `${item.path} — ${item.reason}`));
		const close = contentEl.createDiv({ cls: 'modal-button-container' }).createEl('button', { text: '关闭' });
		close.addEventListener('click', () => this.close());
	}
}

class ConfirmationModal extends Modal {
	private readonly title: string;
	private readonly message: string;
	private readonly confirmText: string;
	private readonly onConfirm: () => Promise<void> | void;

	constructor(app: App, title: string, message: string, confirmText: string, onConfirm: () => Promise<void> | void) {
		super(app);
		this.title = title;
		this.message = message;
		this.confirmText = confirmText;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		this.setTitle(this.title);
		this.contentEl.empty();
		this.contentEl.createEl('p', { text: this.message });
		const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' });
		buttons.createEl('button', { text: '取消' }).addEventListener('click', () => this.close());
		buttons.createEl('button', { text: this.confirmText, cls: 'mod-warning' }).addEventListener('click', () => {
			this.close();
			void this.onConfirm();
		});
	}
}

function appendList(container: HTMLElement, title: string, items: string[]): void {
	new Setting(container).setName(`${title}（${items.length}）`).setHeading();
	if (items.length === 0) {
		container.createEl('p', { text: '无' });
		return;
	}
	const list = container.createEl('ul');
	for (const item of items.slice(0, 120)) list.createEl('li', { text: item });
	if (items.length > 120) list.createEl('li', { text: `另有 ${items.length - 120} 项未显示` });
}

function createPreviewPayload(
	name: string,
	kind: PreviewKind,
	bytes: Uint8Array,
	mimeType: string,
	download?: () => Promise<void>,
	officialUrl?: string,
): PreviewPayload {
	if (kind === 'document' && mimeType !== 'application/pdf') {
		return {
			name,
			kind,
			text: new TextDecoder('utf-8', { fatal: false }).decode(bytes),
			...(download ? { download } : {}),
			...(officialUrl ? { officialUrl } : {}),
		};
	}
	return {
		name,
		kind,
		bytes,
		mimeType,
		...(download ? { download } : {}),
		...(officialUrl ? { officialUrl } : {}),
	};
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function normalizeSettings(data: PersistedData): PluginSettings {
	const deviceId = typeof data.deviceId === 'string' && /^[a-z0-9-]{1,80}$/i.test(data.deviceId)
		? data.deviceId.toLowerCase()
		: createDeviceId();
	const directory = typeof data.cloudDirectoryName === 'string' && isSafeCloudDirectoryName(data.cloudDirectoryName.trim())
		? data.cloudDirectoryName.trim()
		: DEFAULT_CLOUD_DIRECTORY;
	const deviceName = typeof data.deviceName === 'string' && data.deviceName.trim() && data.deviceName.length <= 50
		? data.deviceName.trim()
		: (Platform.isIosApp ? 'iOS' : Platform.isAndroidApp ? 'Android' : 'Windows PC');
	const interval = typeof data.autoSyncIntervalMinutes === 'number' && Number.isFinite(data.autoSyncIntervalMinutes)
		? Math.min(1440, Math.max(1, Math.floor(data.autoSyncIntervalMinutes)))
		: DEFAULT_AUTO_SYNC_MINUTES;
	return {
		language: data.language === 'en' ? 'en' : 'zh-CN',
		cloudDirectoryName: directory,
		deviceName,
		autoSync: data.autoSync === true && data.initialSyncCompleted === true,
		syncOnStartup: data.syncOnStartup === true && data.initialSyncCompleted === true,
		sessionExpired: data.sessionExpired === true,
		autoSyncIntervalMinutes: interval,
		initialSyncCompleted: data.initialSyncCompleted === true,
		lastSummary: normalizeSummary(data.lastSummary),
		lastSyncedAt: typeof data.lastSyncedAt === 'number' && Number.isSafeInteger(data.lastSyncedAt) && data.lastSyncedAt > 0 && data.lastSyncedAt <= 8.64e15
			? data.lastSyncedAt : null,
		deviceId,
		boundAccountId: typeof data.boundAccountId === 'string' && isSafeIdentity(data.boundAccountId)
			? data.boundAccountId : null,
		boundRootFid: typeof data.boundRootFid === 'string' && isSafeIdentity(data.boundRootFid)
			? data.boundRootFid : null,
		snapshots: normalizeSnapshots(data.snapshots),
		pendingApplies: normalizePendingApplies(data.pendingApplies),
		sourceIndex: normalizeSourceIndex(data.sourceIndex),
	};
}

function normalizeSummary(input: unknown): SyncSummary | null {
	if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
	const value = input as Partial<SyncSummary>;
	const counts = [value.uploaded, value.downloaded, value.deleted, value.conflicts];
	if (!counts.every((count) => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) || !Array.isArray(value.skipped)) return null;
	const skipped = value.skipped.flatMap((item) => {
		if (!item || typeof item !== 'object' || typeof item.path !== 'string' || typeof item.reason !== 'string') return [];
		return [{ path: item.path, reason: item.reason }];
	}).slice(0, 500);
	return {
		uploaded: value.uploaded!,
		downloaded: value.downloaded!,
		deleted: value.deleted!,
		conflicts: value.conflicts!,
		skipped,
	};
}

function sanitizeSummary(summary: SyncSummary, cookie: string): SyncSummary {
	const redact = (value: string) => cookie ? value.split(cookie).join('[Cookie 已隐藏]') : value;
	return {
		uploaded: summary.uploaded,
		downloaded: summary.downloaded,
		deleted: summary.deleted,
		conflicts: summary.conflicts,
		skipped: summary.skipped.map((item) => ({ path: redact(item.path), reason: redact(item.reason) })),
	};
}

function normalizeSnapshots(input: unknown): Record<string, SyncSnapshot> {
	const output = emptyMap<SyncSnapshot>();
	if (!input || typeof input !== 'object' || Array.isArray(input)) return output;
	for (const [path, value] of Object.entries(input)) {
		if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
		const snapshot = value as Partial<SyncSnapshot>;
		if ((snapshot.hash === null || (typeof snapshot.hash === 'string' && /^[a-f\d]{64}$/i.test(snapshot.hash))) &&
			Array.isArray(snapshot.heads) && snapshot.heads.every((head) => typeof head === 'string')) {
			output[path] = { hash: snapshot.hash, heads: [...snapshot.heads] };
		}
	}
	return output;
}

function normalizePendingApplies(input: unknown): Record<string, PendingApplyState> {
	const output = emptyMap<PendingApplyState>();
	if (!input || typeof input !== 'object' || Array.isArray(input)) return output;
	for (const [path, value] of Object.entries(input)) {
		if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
		const pending = value as Partial<PendingApplyState>;
		const validHash = (hash: unknown) => hash === null || (typeof hash === 'string' && /^[a-f\d]{64}$/i.test(hash));
		if (validHash(pending.beforeHash) && validHash(pending.desiredHash) &&
			Array.isArray(pending.heads) && pending.heads.every((head) => typeof head === 'string')) {
			output[path] = {
				beforeHash: pending.beforeHash as string | null,
				desiredHash: pending.desiredHash as string | null,
				heads: [...pending.heads],
			};
		}
	}
	return output;
}

function emptyMap<T>(): Record<string, T> {
	return Object.create(null) as Record<string, T>;
}

function isSafeCloudDirectoryName(name: string): boolean {
	return name.length > 0 && name.length <= 80 && name !== '.' && name !== '..' && !/[\\/]/.test(name) && !hasAsciiControl(name);
}

function isSafeIdentity(value: string): boolean {
	return /^[a-z0-9_-]{1,128}$/i.test(value);
}

function filterPairingCookie(cookie: string): string {
	const allowed = new Set(['__pus', '__puus', '__kps', '__uid']);
	const values = new Map<string, string>();
	for (const part of cookie.split(';')) {
		const separator = part.indexOf('=');
		if (separator <= 0) continue;
		const name = part.slice(0, separator).trim();
		const value = part.slice(separator + 1).trim();
		if (!allowed.has(name) || !value || hasAsciiControl(value)) continue;
		values.set(name, value);
	}
	if (!values.has('__pus') && !values.has('__puus')) throw new Error('当前会话没有可导出的夸克网页凭据，请重新扫码登录或检查手动 Cookie');
	return Array.from(values, ([name, value]) => `${name}=${value}`).join('; ');
}

function safeModalError(error: unknown): string {
	let message = error instanceof Error ? error.message : '操作失败';
	message = message.replace(/__(?:pus|puus|kps|uid)\s*[:=]\s*[^\s;,]+/gi, '[夸克 Cookie 已隐藏]');
	message = message.replace(/((?:cookie|authorization|ticket|token)\s*[:=]\s*)[^\s;,]+/gi, '$1[已隐藏]');
	return message.slice(0, 240);
}

function createDeviceId(): string {
	const cryptoApi = typeof window === 'undefined' ? crypto : window.crypto ?? crypto;
	if (typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID().toLowerCase();
	const bytes = new Uint8Array(16);
	cryptoApi.getRandomValues(bytes);
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

class QuarkInlineMediaChild extends MarkdownRenderChild {
	private readonly objectUrls = new Set<string>();
	private readonly listeners: Array<() => void> = [];

	trackCleanup(cleanup: () => void): void {
		this.listeners.push(cleanup);
	}

	trackObjectUrl(url: string): void {
		this.objectUrls.add(url);
	}

	whenVisible(element: HTMLElement, load: () => void): void {
		this.listeners.push(loadWhenVisible(element, load));
	}

	onClick(element: HTMLElement, callback: (event: MouseEvent) => void): void {
		element.addEventListener('click', callback);
		this.listeners.push(() => element.removeEventListener('click', callback));
	}

	onunload(): void {
		for (const removeListener of this.listeners) removeListener();
		this.listeners.length = 0;
		for (const url of this.objectUrls) URL.revokeObjectURL(url);
		this.objectUrls.clear();
	}
}

function createInlineMedia(payload: PreviewPayload, owner: QuarkInlineMediaChild): HTMLElement | undefined {
	if (payload.stream) {
		const container = createSpan();
		container.className = 'quark-live-reference';
		owner.trackCleanup(mountQuarkVideo(container, payload.stream));
		return container;
	}
	if (!payload.bytes || !payload.mimeType || !['image', 'audio', 'video'].includes(payload.kind)) return undefined;
	const buffer = payload.bytes.buffer.slice(payload.bytes.byteOffset, payload.bytes.byteOffset + payload.bytes.byteLength) as ArrayBuffer;
	const url = URL.createObjectURL(new Blob([buffer], { type: payload.mimeType }));
	owner.trackObjectUrl(url);
	if (payload.kind === 'image') {
		const image = createEl('img');
		image.className = 'quark-inline-media-image';
		image.alt = payload.name;
		image.src = url;
		return image;
	}
	const media = createEl(payload.kind === 'audio' ? 'audio' : 'video');
	media.className = `quark-inline-media-${payload.kind}`;
	media.controls = true;
	media.preload = 'none';
	media.src = url;
	return media;
}
