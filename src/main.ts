import {
	Modal,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
	type App,
	type TextComponent,
} from 'obsidian';
import QRCode from 'qrcode';
import type { PendingApplyState, SyncSummary } from './sync-service.ts';
import { QuarkSyncService } from './sync-service.ts';
import type { SyncPlan, SyncSnapshot } from './sync-engine.ts';
import { QuarkAuthenticationError, QuarkClient } from './quark-api.ts';
import { QuarkTransport, type HttpRequest, type HttpResponse } from './transport.ts';
import { QuarkQrLogin, type QuarkQrSession } from './quark-login.ts';
import { createPairingCode, readPairingCode, type PairingPayload } from './pairing-code.ts';

const PLUGIN_ID = 'quark-note-sync';
const DEFAULT_CLOUD_DIRECTORY = 'Obsidian Notes';
const DEFAULT_AUTO_SYNC_MINUTES = 5;

interface PluginSettings {
	cloudDirectoryName: string;
	deviceName: string;
	autoSync: boolean;
	syncOnStartup: boolean;
	sessionExpired: boolean;
	autoSyncIntervalMinutes: number;
	initialSyncCompleted: boolean;
	lastSummary: SyncSummary | null;
	deviceId: string;
	boundAccountId: string | null;
	boundRootFid: string | null;
	snapshots: Record<string, SyncSnapshot>;
	pendingApplies: Record<string, PendingApplyState>;
}

type PersistedData = Partial<PluginSettings>;
interface InspectedCredential {
	accountId: string;
	rootFid?: string;
	cookie: string;
	nickname?: string;
}

type AccountView = { state: 'signed-out' | 'expired' } | { state: 'connected'; label: string };

export default class QuarkNoteSyncPlugin extends Plugin {
	private config!: PluginSettings;
	private busy = false;
	private unloading = false;
	private autoSyncTimer: number | undefined;
	private credentialId = '';
	private credentialRevision = 0;
	private startupSyncPending = true;
	private layoutReady = false;
	private accountNickname: string | undefined;
	private settingsTab!: QuarkSettingsTab;

	async onload(): Promise<void> {
		const data = (await this.loadData()) as PersistedData | null;
		this.config = normalizeSettings(data ?? {});
		this.credentialId = `${PLUGIN_ID}-cookie-${this.config.deviceId}`;
		this.settingsTab = new QuarkSettingsTab(this.app, this);
		this.addSettingTab(this.settingsTab);

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
				if (Platform.isMobileApp || this.accountView.state === 'connected' || this.busy) return false;
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
			this.runStartupSync();
		});
		this.refreshAutoSyncTimer();
	}

	onunload(): void {
		this.unloading = true;
		if (this.autoSyncTimer !== undefined) {
			window.clearInterval(this.autoSyncTimer);
			this.autoSyncTimer = undefined;
		}
	}

	get settingsView(): Pick<PluginSettings, 'cloudDirectoryName' | 'deviceName' | 'autoSync' | 'syncOnStartup' | 'autoSyncIntervalMinutes' | 'lastSummary'> {
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
		return {
			state: 'connected',
			label: this.accountNickname ?? (id && id.length > 4 ? '账号 ····' + id.slice(-4) : '夸克账号'),
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
			this.config.sessionExpired = false;
			this.refreshAutoSyncTimer();
			await this.persistData();
			new Notice('已退出本设备的夸克登录');
		});
	}

	openQrLogin(): void {
		if (Platform.isMobileApp) {
			new Notice('请在 Windows Obsidian 中使用扫码登录；手机可导入电脑授权码');
			return;
		}
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
			this.busy = false;
			this.settingsTab.refreshAccount();
			this.runStartupSync();
		});
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
		if (!name || name.length > 50 || /[\r\n\u0000-\u001f\u007f]/.test(name)) {
			new Notice('设备名称需为 1 至 50 个字符，且不能包含换行或控制字符');
			return;
		}
		this.config.deviceName = name;
		await this.persistData();
		new Notice('设备名称已保存；同步身份仍使用独立设备 ID');
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

	async previewSync(): Promise<void> {
		const plan = await this.runExclusive('读取同步预览', async () => {
			const service = this.createService(this.requireCookie());
			return await service.preview();
		}, true);
		if (plan && !this.unloading) new PlanModal(this.app, plan, false).open();
	}

	async requestSync(): Promise<void> {
		if (this.config.initialSyncCompleted) {
			await this.performSync(false);
			return;
		}
		const previewDirectoryName = this.config.cloudDirectoryName;
		const previewCredentialRevision = this.credentialRevision;
		const plan = await this.runExclusive('读取首次同步预览', async () => {
			const service = this.createService(this.requireCookie());
			return await service.preview();
		}, true);
		if (!plan || this.unloading) return;
		new PlanModal(this.app, plan, true, () => {
			if (this.config.cloudDirectoryName !== previewDirectoryName || this.credentialRevision !== previewCredentialRevision) {
				new Notice('云端目录或 Cookie 已更改；请重新预览后再确认首次同步');
				return;
			}
			void this.performSync(true, false);
		}).open();
	}

	private async performSync(confirmedInitialSync: boolean, automatic = false): Promise<void> {
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
				if (confirmedInitialSync) this.config.initialSyncCompleted = true;
				await this.persistData();
				if (confirmedInitialSync) this.refreshAutoSyncTimer();
			}
			return result;
		}, true);
		if (summary && !this.unloading && !automatic) new SyncSummaryModal(this.app, summary).open();
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
		return new QuarkTransport(Platform.isMobileApp || Platform.isAndroidApp);
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
			cloudDirectoryName: this.config.cloudDirectoryName,
			deviceName: this.config.deviceName,
			autoSync: this.config.autoSync,
			syncOnStartup: this.config.syncOnStartup,
			sessionExpired: this.config.sessionExpired,
			autoSyncIntervalMinutes: this.config.autoSyncIntervalMinutes,
			initialSyncCompleted: this.config.initialSyncCompleted,
			lastSummary: this.config.lastSummary,
			deviceId: this.config.deviceId,
			boundAccountId: this.config.boundAccountId,
			boundRootFid: this.config.boundRootFid,
			snapshots: this.config.snapshots,
			pendingApplies: this.config.pendingApplies,
		});
	}
}

class QuarkSettingsTab extends PluginSettingTab {
	private readonly plugin: QuarkNoteSyncPlugin;
	private accountSection: HTMLElement | undefined;

	constructor(app: App, plugin: QuarkNoteSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h2', { text: '夸克笔记同步' });
		const last = this.plugin.settingsView.lastSummary;
		containerEl.createEl('p', {
			text: last
				? `上次同步：上传 ${last.uploaded}，下载 ${last.downloaded}，删除 ${last.deleted}，冲突 ${last.conflicts}，跳过 ${last.skipped.length}`
				: '上次同步：暂无记录',
		});

		this.accountSection = containerEl.createDiv();
		this.refreshAccount();

		let cookieInput!: TextComponent;
		const advanced = containerEl.createEl('details');
		advanced.createEl('summary', { text: '高级设置（手动 Cookie）' });
		new Setting(advanced)
			.setName('夸克 Cookie')
			.setDesc('扫码登录或授权导入不可用时，可在此手动录入。Cookie 保存在 Obsidian 安全存储中；输入框不会回填已保存内容。留空保存会清除此设备的 Cookie。')
			.addText((text) => {
				cookieInput = text;
				text.inputEl.type = 'password';
				text.inputEl.autocomplete = 'off';
				text.inputEl.setAttribute('autocapitalize', 'off');
				text.inputEl.setAttribute('spellcheck', 'false');
				text.setPlaceholder(this.plugin.savedCookieExists ? '此设备已保存；输入新 Cookie 可替换' : '粘贴此设备的夸克 Cookie');
				text.setDisabled(this.plugin.isBusy);
			})
			.addButton((button) => button
				.setButtonText('保存 Cookie')
				.setDisabled(this.plugin.isBusy)
				.onClick(async () => {
					await this.plugin.saveCookie(cookieInput.getValue());
					cookieInput.setValue('');
					cookieInput.setPlaceholder(this.plugin.savedCookieExists ? '此设备已保存；输入新 Cookie 可替换' : '粘贴此设备的夸克 Cookie');
				}));

		let cloudInput!: TextComponent;
		new Setting(containerEl)
			.setName('夸克云端目录')
			.setDesc('云盘根目录下的单层文件夹名称；切换已有同步状态会要求确认并清除本地快照。')
			.addText((text) => {
				cloudInput = text;
				text.setValue(this.plugin.settingsView.cloudDirectoryName);
				text.setPlaceholder(DEFAULT_CLOUD_DIRECTORY);
				text.setDisabled(this.plugin.isBusy);
			})
			.addButton((button) => button
				.setButtonText('保存')
				.setDisabled(this.plugin.isBusy)
				.onClick(() => void this.plugin.saveCloudDirectoryName(cloudInput.getValue())));

		let deviceInput!: TextComponent;
		new Setting(containerEl)
			.setName('设备名称')
			.setDesc('仅用于本机辨识；同步历史仍使用独立且唯一的设备 ID。')
			.addText((text) => {
				deviceInput = text;
				text.setValue(this.plugin.settingsView.deviceName);
				text.setPlaceholder('例如：Windows PC');
				text.setDisabled(this.plugin.isBusy);
			})
			.addButton((button) => button
				.setButtonText('保存')
				.setDisabled(this.plugin.isBusy)
				.onClick(() => void this.plugin.saveDeviceName(deviceInput.getValue())));

		new Setting(containerEl)
			.setName('自动同步')
			.setDesc(this.plugin.isFirstSyncComplete ? '应用打开期间按设定间隔同步；默认关闭。' : '首次手动确认并完成同步后才能开启。')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settingsView.autoSync)
				.setDisabled(this.plugin.isBusy || !this.plugin.isFirstSyncComplete)
				.onChange((value) => void this.plugin.setAutoSync(value)));

		new Setting(containerEl)
			.setName('打开 Obsidian 时同步')
			.setDesc(this.plugin.isFirstSyncComplete ? '仓库载入后同步一次，独立于定时同步。' : '首次手动确认并完成同步后才能开启。')
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settingsView.syncOnStartup)
				.setDisabled(this.plugin.isBusy || !this.plugin.isFirstSyncComplete)
				.onChange(async (enabled) => {
					await this.plugin.setSyncOnStartup(enabled);
					toggle.setValue(this.plugin.settingsView.syncOnStartup);
				}));

		let intervalInput!: TextComponent;
		new Setting(containerEl)
			.setName('自动同步间隔（分钟）')
			.setDesc('默认 5 分钟，可设为 1 至 1440 分钟。')
			.addText((text) => {
				intervalInput = text;
				text.inputEl.type = 'number';
				text.inputEl.min = '1';
				text.inputEl.max = '1440';
				text.setValue(String(this.plugin.settingsView.autoSyncIntervalMinutes));
				text.setDisabled(this.plugin.isBusy);
			})
			.addButton((button) => button
				.setButtonText('保存')
				.setDisabled(this.plugin.isBusy)
				.onClick(() => void this.plugin.setAutoSyncInterval(Number(intervalInput.getValue()))));

		new Setting(containerEl)
			.setName('同步操作')
			.setDesc('预览始终只读；首次同步需要查看预览并再次确认。')
			.addButton((button) => button
				.setButtonText('预览同步变化')
				.setDisabled(this.plugin.isBusy)
				.onClick(() => void this.plugin.previewSync()))
			.addButton((button) => button
				.setButtonText('立即同步夸克')
				.setCta()
				.setDisabled(this.plugin.isBusy)
				.onClick(() => void this.plugin.requestSync()));

		new Setting(containerEl)
			.setName('上次同步详情')
			.setDesc(last ? `跳过路径：${last.skipped.length}` : '还没有同步记录。')
			.addButton((button) => button
				.setButtonText('查看状态与跳过路径')
				.setDisabled(this.plugin.isBusy || !last)
				.onClick(() => this.plugin.showLastSummary()));

		new Setting(containerEl)
			.setName('连接检查')
			.setDesc('只读取夸克账号和根目录列表，不创建或修改云端文件。')
			.addButton((button) => button
				.setButtonText('检查夸克连接')
				.setDisabled(this.plugin.isBusy)
				.onClick(() => void this.plugin.checkConnection()));
	}

	hide(): void {
		this.accountSection = undefined;
	}

	refreshAccount(): void {
		const section = this.accountSection;
		if (!section) return;
		section.empty();
		const account = this.plugin.accountView;
		const row = new Setting(section).setName('夸克账号');
		if (account.state === 'connected') {
			row.setDesc('已登录 · ' + account.label);
			if (Platform.isDesktopApp && !Platform.isMobileApp) {
				row.addButton((button) => button
					.setButtonText('导出到手机')
					.setDisabled(this.plugin.isBusy)
					.onClick(() => new ExportPairingModal(this.app, this.plugin).open()));
			}
		} else {
			row.setDesc(account.state === 'expired' ? '登录已失效，请重新授权。' : '此设备尚未连接夸克账号。');
			if (Platform.isDesktopApp && !Platform.isMobileApp) {
				row.addButton((button) => button
					.setButtonText('扫码登录')
					.setCta()
					.setDisabled(this.plugin.isBusy)
					.onClick(() => this.plugin.openQrLogin()));
			} else if (Platform.isMobileApp) {
				row.addButton((button) => button
					.setButtonText('导入电脑授权')
					.setCta()
					.setDisabled(this.plugin.isBusy)
					.onClick(() => new ImportPairingModal(this.app, this.plugin).open()));
			}
		}
		if (account.state !== 'signed-out') {
			row.addButton((button) => button
				.setButtonText('退出登录')
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

	constructor(app: App, login: QuarkQrLogin, onAuthorized: (cookie: string, stillCurrent: () => boolean) => Promise<void>, onClosed: () => void) {
		super(app);
		this.login = login;
		this.onAuthorized = onAuthorized;
		this.onClosed = onClosed;
	}

	onOpen(): void {
		this.setTitle('夸克网页扫码登录');
		this.contentEl.empty();
		this.contentEl.createEl('p', { text: '请使用自己的夸克 App 扫描下方二维码，并在手机中确认登录。插件只会读取夸克网页登录接口返回的会话 Cookie。' });
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
		this.closed = true;
		this.stopPolling();
		this.qrEl?.empty();
		this.onClosed();
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
			image.src = await QRCode.toDataURL(session.qrUrl, { width: 260, margin: 1, errorCorrectionLevel: 'M' });
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
		const code = this.contentEl.createEl('textarea', { attr: { rows: '7', readonly: 'true', 'aria-label': '加密授权码' } });
		code.style.width = '100%';
		code.style.display = 'none';
		const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' });
		const generate = buttons.createEl('button', { text: '生成授权码', cls: 'mod-cta' });
		const copy = buttons.createEl('button', { text: '复制授权码' });
		copy.disabled = true;
		copy.addEventListener('click', () => void copyText(code.value, status));
		buttons.createEl('button', { text: '关闭' }).addEventListener('click', () => this.close());
		generate.addEventListener('click', async () => {
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
				code.style.display = '';
				copy.disabled = false;
				status.setText('授权码已生成。请在 15 分钟内导入手机；密码不会保存。');
			} finally {
				generate.disabled = false;
			}
		});
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
		const code = this.contentEl.createEl('textarea', { attr: { rows: '7', placeholder: '粘贴 QPS1 开头的授权码', 'aria-label': '加密授权码' } });
		code.style.width = '100%';
		code.setAttribute('autocapitalize', 'off');
		code.setAttribute('spellcheck', 'false');
		const password = this.contentEl.createEl('input', { attr: { type: 'password', autocomplete: 'off', placeholder: '授权密码' } });
		password.setAttribute('autocapitalize', 'off');
		password.setAttribute('spellcheck', 'false');
		const status = this.contentEl.createEl('p', { text: '' });
		const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' });
		const importButton = buttons.createEl('button', { text: '验证并导入', cls: 'mod-cta' });
		buttons.createEl('button', { text: '取消' }).addEventListener('click', () => this.close());
		importButton.addEventListener('click', async () => {
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
		});
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
	container.createEl('h4', { text: `${title}（${items.length}）` });
	if (items.length === 0) {
		container.createEl('p', { text: '无' });
		return;
	}
	const list = container.createEl('ul');
	for (const item of items.slice(0, 120)) list.createEl('li', { text: item });
	if (items.length > 120) list.createEl('li', { text: `另有 ${items.length - 120} 项未显示` });
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
		: (Platform.isAndroidApp ? 'Android' : 'Windows PC');
	const interval = typeof data.autoSyncIntervalMinutes === 'number' && Number.isFinite(data.autoSyncIntervalMinutes)
		? Math.min(1440, Math.max(1, Math.floor(data.autoSyncIntervalMinutes)))
		: DEFAULT_AUTO_SYNC_MINUTES;
	return {
		cloudDirectoryName: directory,
		deviceName,
		autoSync: data.autoSync === true && data.initialSyncCompleted === true,
		syncOnStartup: data.syncOnStartup === true && data.initialSyncCompleted === true,
		sessionExpired: data.sessionExpired === true,
		autoSyncIntervalMinutes: interval,
		initialSyncCompleted: data.initialSyncCompleted === true,
		lastSummary: normalizeSummary(data.lastSummary),
		deviceId,
		boundAccountId: typeof data.boundAccountId === 'string' && isSafeIdentity(data.boundAccountId)
			? data.boundAccountId : null,
		boundRootFid: typeof data.boundRootFid === 'string' && isSafeIdentity(data.boundRootFid)
			? data.boundRootFid : null,
		snapshots: normalizeSnapshots(data.snapshots),
		pendingApplies: normalizePendingApplies(data.pendingApplies),
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
	return name.length > 0 && name.length <= 80 && name !== '.' && name !== '..' && !/[\\/\u0000-\u001f\u007f]/.test(name);
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
		if (!allowed.has(name) || !value || /[\r\n\u0000-\u001f\u007f]/.test(value)) continue;
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

async function copyText(value: string, status: HTMLElement): Promise<void> {
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(value);
			status.setText('授权码已复制；密码仍需单独传给手机。');
			return;
		}
		const input = document.createElement('textarea');
		input.value = value;
		input.style.position = 'fixed';
		input.style.opacity = '0';
		document.body.appendChild(input);
		input.select();
		const copied = document.execCommand('copy');
		input.remove();
		status.setText(copied ? '授权码已复制；密码仍需单独传给手机。' : '复制失败，请手动选择并复制授权码。');
	} catch {
		status.setText('复制失败，请手动选择并复制授权码。');
	}
}

function createDeviceId(): string {
	const cryptoApi = globalThis.crypto;
	if (typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID().toLowerCase();
	const bytes = new Uint8Array(16);
	cryptoApi.getRandomValues(bytes);
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
