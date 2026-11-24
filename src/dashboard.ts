import { ItemView, Notice, setIcon, type WorkspaceLeaf } from 'obsidian';
import type { SyncPlan } from './sync-engine.ts';

export const DASHBOARD_VIEW_TYPE = 'quark-note-sync-dashboard';

export type DashboardLanguage = 'zh-CN' | 'en';

export interface QuarkDashboardView {
	language: DashboardLanguage;
	account: {
		status: 'connected' | 'expired' | 'signed-out';
		label?: string;
	};
	vaultName: string;
	periodicSync: {
		enabled: boolean;
		intervalMinutes: number;
		syncOnStartup: boolean;
	};
	busy: boolean;
	canEnableAutoSync?: boolean;
	inline?: {
		plan: SyncPlan;
		confirm?: boolean;
	};
	cloudQuota?: {
		usedBytes: number;
		freeBytes: number;
	};
	quotaLoading?: boolean;
	skippedDetails?: readonly { path: string; reason: string }[];
	vault: {
		totalBytes: number;
		fileCount?: number;
		byKind: readonly {
			kind: string;
			label?: string;
			files: number;
			bytes: number;
		}[];
		largestFiles: readonly {
			path: string;
			name: string;
			bytes: number;
		}[];
	};
	latestSync?: {
		at?: number;
		uploaded: number;
		downloaded: number;
		deleted: number;
		conflicts: number;
		skipped: number;
	};
}

export interface QuarkDashboardActions {
	ready?: () => void;
	refresh?: () => void | Promise<void>;
	sync?: () => void | Promise<void>;
	preview?: () => void | Promise<void>;
	checkConnection?: () => void | Promise<void>;
	settings?: () => void | Promise<void>;
	setPeriodicSync?: (enabled: boolean) => void | Promise<void>;
	setStartupSync?: (enabled: boolean) => void | Promise<void>;
	confirmSync?: () => void | Promise<void>;
	dismissPlan?: () => void | Promise<void>;
	login?: () => void | Promise<void>;
	exportPairing?: () => void | Promise<void>;
	importPairing?: () => void | Promise<void>;
	logout?: () => void | Promise<void>;
	showLastSync?: () => void | Promise<void>;
	openFile?: (path: string) => void | Promise<void>;
	close?: () => void;
}

type DashboardActionName = Exclude<keyof QuarkDashboardActions, 'ready' | 'close' | 'openFile' | 'showLastSync' | 'setPeriodicSync' | 'setStartupSync'>;

type DashboardCopy = {
	title: string;
	refresh: string;
	account: string;
	vault: string;
	periodic: string;
	startup: string;
	on: string;
	off: string;
	minutes: (value: number) => string;
	sync: string;
	preview: string;
	check: string;
	settings: string;
	advancedSettings: string;
	login: string;
	exportPairing: string;
	importPairing: string;
	logout: string;
	lastSync: string;
	connected: string;
	expired: string;
	signedOut: string;
	cloud: string;
	used: string;
	free: string;
	quotaScale: (total: string, usedPercent: string) => string;
	quotaLoading: string;
	quotaUnavailable: string;
	connectForQuota: string;
	vaultTotal: string;
	files: string;
	byKind: string;
	latestActivity: string;
	noSync: string;
	uploaded: string;
	downloaded: string;
	deleted: string;
	conflicts: string;
	skipped: string;
	largestFiles: string;
	name: string;
	size: string;
	type: string;
	path: string;
	noFiles: string;
	noBreakdown: string;
	unknownKind: string;
	never: string;
	pathLabel: string;
	fileType: (path: string) => string;
	planTitle: string;
	planSummary: (events: string, paths: string, skipped: string) => string;
	planReadOnly: string;
	planInitial: string;
	planPaths: string;
	planSkipped: string;
	planNoPaths: string;
	planMore: (count: string) => string;
	planDeleted: string;
	planApply: string;
	planNoFinal: string;
	planConflicts: (count: string) => string;
	confirmSync: string;
	dismiss: string;
	skippedDetails: string;
	skippedEmpty: string;
	lastSyncSummary: (uploaded: string, downloaded: string, deleted: string, conflicts: string, skipped: string) => string;
	actionFailed: string;
	fileOpenFailed: string;
	date: (value: number) => string;
};

const copy: Record<DashboardLanguage, DashboardCopy> = {
	'zh-CN': {
		title: '夸克同步面板',
		refresh: '刷新',
		account: '账号',
		vault: '当前库',
		periodic: '自动同步',
		startup: '开机同步',
		on: '已开启',
		off: '已关闭',
		minutes: (value) => `每 ${value} 分钟`,
		sync: '立即同步夸克',
		preview: '预览同步变化',
		check: '检查夸克连接',
		settings: '同步设置',
		advancedSettings: '打开完整设置',
		login: '登录夸克',
		exportPairing: '导出到手机',
		importPairing: '导入授权',
		logout: '退出登录',
		lastSync: '上次同步详情',
		connected: '已连接',
		expired: '登录已失效',
		signedOut: '尚未登录',
		cloud: '夸克云空间',
		used: '已用空间',
		free: '剩余空间',
		quotaScale: (total, usedPercent) => `总容量 ${total} · 已用 ${usedPercent}`,
		quotaLoading: '正在读取云空间…',
		quotaUnavailable: '暂时无法读取云空间',
		connectForQuota: '连接夸克账号后查看云空间',
		vaultTotal: '本地仓库空间',
		files: '个文件',
		byKind: '按文件类型',
		latestActivity: '最近一次同步',
		noSync: '暂无同步记录',
		uploaded: '上传（本地 → 夸克）',
		downloaded: '下载（夸克 → 本地）',
		deleted: '删除（同步移除）',
		conflicts: '冲突副本',
		skipped: '跳过（见详情）',
		largestFiles: '仓库中最大的 5 个文件',
		name: '文件',
		size: '大小',
		type: '类型',
		path: '路径',
		noFiles: '当前库中没有文件',
		noBreakdown: '暂无文件类型统计',
		unknownKind: '其他',
		never: '时间未记录',
		pathLabel: '相对路径',
		fileType: (path) => fileTypeLabel(path, 'zh-CN'),
		planTitle: '同步预览',
		planSummary: (events, paths, skipped) => `待发布版本 ${events} · 待检查路径 ${paths} · 跳过 ${skipped}`,
		planReadOnly: '这是只读预览，不会写入本地或云端文件。',
		planInitial: '以下预览只读取本地和云端内容。确认后才会开始首次同步，并可能创建云端同步目录。',
		planPaths: '计划路径',
		planSkipped: '跳过路径',
		planNoPaths: '没有需要同步的路径。',
		planMore: (count) => `另有 ${count} 个路径`,
		planDeleted: '远端为删除版本',
		planApply: '检查/应用远端版本',
		planNoFinal: '无最终版本',
		planConflicts: (count) => `冲突副本 ${count} 个`,
		confirmSync: '确认并开始同步',
		dismiss: '收起',
		skippedDetails: '跳过路径及原因',
		skippedEmpty: '没有跳过的路径。',
		lastSyncSummary: (uploaded, downloaded, deleted, conflicts, skipped) => `上传 ${uploaded} · 下载 ${downloaded} · 删除 ${deleted} · 冲突 ${conflicts} · 跳过 ${skipped}`,
		actionFailed: '操作未完成，请重试。',
		fileOpenFailed: '无法打开这个文件。',
		date: (value) => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(value),
	},
	en: {
		title: 'Quark Sync Dashboard',
		refresh: 'Refresh',
		account: 'Account',
		vault: 'Current vault',
		periodic: 'Periodic sync',
		startup: 'Sync on startup',
		on: 'On',
		off: 'Off',
		minutes: (value) => `Every ${value} min`,
		sync: 'Sync now',
		preview: 'Preview changes',
		check: 'Check connection',
		settings: 'Sync settings',
		advancedSettings: 'Open full settings',
		login: 'Sign in to Quark',
		exportPairing: 'Export to phone',
		importPairing: 'Import access',
		logout: 'Sign out',
		lastSync: 'Last sync details',
		connected: 'Connected',
		expired: 'Session expired',
		signedOut: 'Signed out',
		cloud: 'Quark cloud storage',
		used: 'Used',
		free: 'Free',
		quotaScale: (total, usedPercent) => `Total ${total} · ${usedPercent} used`,
		quotaLoading: 'Loading cloud storage…',
		quotaUnavailable: 'Cloud storage is unavailable',
		connectForQuota: 'Connect a Quark account to view storage',
		vaultTotal: 'Local vault space',
		files: 'files',
		byKind: 'By file type',
		latestActivity: 'Latest sync',
		noSync: 'No sync history yet',
		uploaded: 'Uploaded (local → Quark)',
		downloaded: 'Downloaded (Quark → local)',
		deleted: 'Deleted (synced removal)',
		conflicts: 'Conflict copies',
		skipped: 'Skipped',
		largestFiles: 'Largest 5 files in this vault',
		name: 'File',
		size: 'Size',
		type: 'Type',
		path: 'Path',
		noFiles: 'This vault has no files',
		noBreakdown: 'No file type statistics available',
		unknownKind: 'Other',
		never: 'Time not recorded',
		pathLabel: 'Vault path',
		fileType: (path) => fileTypeLabel(path, 'en'),
		planTitle: 'Sync preview',
		planSummary: (events, paths, skipped) => `${events} versions · ${paths} paths · ${skipped} skipped`,
		planReadOnly: 'This is a read only preview. It does not write local or cloud files.',
		planInitial: 'This preview only reads local and cloud content. Confirm to start the first sync; a cloud sync folder may be created.',
		planPaths: 'Planned paths',
		planSkipped: 'Skipped paths',
		planNoPaths: 'No paths need syncing.',
		planMore: (count) => `${count} more paths`,
		planDeleted: 'Remote deletion',
		planApply: 'Check/apply remote version',
		planNoFinal: 'No final version',
		planConflicts: (count) => `${count} conflict copies`,
		confirmSync: 'Confirm and sync',
		dismiss: 'Dismiss',
		skippedDetails: 'Skipped paths and reasons',
		skippedEmpty: 'No skipped paths.',
		lastSyncSummary: (uploaded, downloaded, deleted, conflicts, skipped) => `Uploaded ${uploaded} · Downloaded ${downloaded} · Deleted ${deleted} · Conflicts ${conflicts} · Skipped ${skipped}`,
		actionFailed: 'Could not complete this action. Try again.',
		fileOpenFailed: 'Could not open this file.',
		date: (value) => new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(value),
	},
};

export class QuarkDashboardSidebar extends ItemView {
	private view: QuarkDashboardView;
	private actions: QuarkDashboardActions;
	private readonly root: HTMLDivElement;
	private isOpen = false;
	private settingsExpanded = false;
	private skippedExpanded = false;

	constructor(leaf: WorkspaceLeaf, view: QuarkDashboardView, actions: QuarkDashboardActions) {
		super(leaf);
		this.view = view;
		this.actions = actions;
		this.contentEl.addClass('quark-dashboard-view-content');
		this.root = this.contentEl.createDiv({ cls: 'quark-dashboard' });
	}

	getViewType(): string {
		return DASHBOARD_VIEW_TYPE;
	}

	getDisplayText(): string {
		return copy[this.view.language].title;
	}

	getIcon(): string {
		return 'layout-dashboard';
	}

	refreshView(view: QuarkDashboardView, actions?: QuarkDashboardActions): void {
		this.view = view;
		if (actions) {
			this.actions = {
				...actions,
				ready: actions.ready ?? this.actions.ready,
				close: actions.close ?? this.actions.close,
			};
		}
		if (this.isOpen) this.render();
	}

	async onOpen(): Promise<void> {
		this.isOpen = true;
		this.render();
		this.actions.ready?.();
	}

	async onClose(): Promise<void> {
		this.isOpen = false;
		this.root.empty();
		this.actions.close?.();
	}

	private render(): void {
		if (!this.isOpen) return;
		this.root.empty();
		const text = copy[this.view.language];
		this.root.setAttr('lang', this.view.language === 'en' ? 'en' : 'zh-CN');

		const header = this.root.createDiv({ cls: 'quark-dashboard-header' });
		const heading = header.createDiv({ cls: 'quark-dashboard-heading' });
		const title = heading.createEl('h2', { cls: 'quark-dashboard-title' });
		const titleIcon = title.createSpan({ cls: 'quark-dashboard-title-icon' });
		setIcon(titleIcon, 'box');
		title.createSpan({ text: text.title });
		const refresh = this.makeButton(header, text.refresh, 'quark-dashboard-refresh', 'refresh-cw', () => this.runAction('refresh'));
		refresh.setAttr('aria-label', text.refresh);
		refresh.toggleAttribute('disabled', this.view.busy || !this.actions.refresh);

		this.renderStatusStrip(text);
		this.renderPrimaryActions(text);
		if (this.settingsExpanded) this.renderInlineSettings(text);
		this.renderSecondaryActions(text);
		if (this.view.inline) this.renderInlinePlan(text);
		if (this.skippedExpanded) this.renderSkippedDetails(text);

		const panels = this.root.createDiv({ cls: 'quark-dashboard-panels' });
		this.renderCloudCard(panels, text);
		this.renderBreakdown(panels, text);
		this.renderSyncActivity(panels, text);
		this.renderLargestFiles(text);
	}

	private renderStatusStrip(text: DashboardCopy): void {
		const strip = this.root.createDiv({ cls: 'quark-dashboard-status' });
		this.renderStatusItem(strip, text.account, this.accountStateLabel(text), 'quark-dashboard-account', this.view.account.status === 'connected' ? 'circle-check' : 'circle-alert', this.view.account.status);
		this.renderStatusItem(strip, text.vault, this.view.vaultName || '—', 'quark-dashboard-status-vault', 'folder');
		const periodic = this.view.periodicSync.enabled
			? text.minutes(safeInteger(this.view.periodicSync.intervalMinutes))
			: text.off;
		this.renderStatusItem(strip, text.periodic, periodic, 'quark-dashboard-status-periodic', 'refresh-cw', this.view.periodicSync.enabled ? 'on' : 'off');
		this.renderStatusItem(strip, text.startup, this.view.periodicSync.syncOnStartup ? text.on : text.off, 'quark-dashboard-status-startup', 'power', this.view.periodicSync.syncOnStartup ? 'on' : 'off');
	}

	private renderStatusItem(parent: HTMLElement, label: string, value: string, cls: string, icon: string, state?: string): void {
		const item = parent.createDiv({ cls: `quark-dashboard-status-item ${cls}` });
		const iconEl = item.createSpan({ cls: 'quark-dashboard-status-icon' });
		setIcon(iconEl, icon);
		const text = item.createDiv({ cls: 'quark-dashboard-status-copy' });
		text.createSpan({ cls: 'quark-dashboard-status-label', text: label });
		text.createSpan({ cls: `quark-dashboard-status-value${state ? ` is-${state}` : ''}`, text: value });
	}

	private renderPrimaryActions(text: DashboardCopy): void {
		const actions = this.root.createDiv({ cls: 'quark-dashboard-primary-actions', attr: { role: 'group', 'aria-label': text.sync } });
		this.actionButton(actions, text.sync, 'quark-dashboard-button-primary', 'sync', 'refresh-cw', true);
		this.actionButton(actions, text.preview, 'quark-dashboard-button-secondary', 'preview', 'eye', true);
		this.actionButton(actions, text.check, 'quark-dashboard-button-secondary', 'checkConnection', 'wifi', true, false);
		const settings = this.makeButton(actions, text.settings, 'quark-dashboard-button-secondary quark-dashboard-settings-toggle', 'settings', () => {
			this.settingsExpanded = !this.settingsExpanded;
			this.render();
		});
		settings.setAttr('aria-expanded', String(this.settingsExpanded));
	}

	private renderInlineSettings(text: DashboardCopy): void {
		const panel = this.root.createDiv({ cls: 'quark-dashboard-inline-settings' });
		panel.createEl('h3', { cls: 'quark-dashboard-section-title', text: text.settings });
		this.renderToggle(panel, text.periodic, this.view.periodicSync.enabled, this.actions.setPeriodicSync, this.view.canEnableAutoSync);
		this.renderToggle(panel, text.startup, this.view.periodicSync.syncOnStartup, this.actions.setStartupSync, this.view.canEnableAutoSync);
		if (this.actions.settings) {
			const advanced = this.makeButton(panel, text.advancedSettings, 'quark-dashboard-advanced-settings', 'sliders-horizontal', () => this.runAction('settings'));
			advanced.toggleAttribute('disabled', this.view.busy);
		}
	}

	private renderToggle(parent: HTMLElement, label: string, checked: boolean, action: ((enabled: boolean) => void | Promise<void>) | undefined, canEnable?: boolean): void {
		const row = parent.createDiv({ cls: 'quark-dashboard-toggle-row' });
		const id = `quark-dashboard-toggle-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
		row.createEl('label', { cls: 'quark-dashboard-toggle-label', text: label, attr: { for: id } });
		const input = row.createEl('input', { cls: 'quark-dashboard-toggle-input', attr: { type: 'checkbox', id } });
		input.checked = checked;
		input.disabled = this.view.busy || !action || (canEnable === false && !checked);
		input.setAttr('aria-label', label);
		input.addEventListener('change', () => {
			if (this.view.busy || !action) return;
			if (canEnable === false && input.checked) {
				input.checked = false;
				return;
			}
			this.runValueAction(() => action(input.checked), () => this.render());
		});
	}

	private renderCloudCard(parent: HTMLElement, text: DashboardCopy): void {
		const card = this.createCard(parent, 'quark-dashboard-cloud-card', text.cloud, 'hard-drive');
		const quota = this.view.cloudQuota;
		if (!quota) {
			const message = this.view.account.status === 'signed-out'
				? text.connectForQuota
				: this.view.account.status === 'expired'
					? text.expired
					: this.view.quotaLoading
						? text.quotaLoading
						: text.quotaUnavailable;
			card.createEl('p', { cls: 'quark-dashboard-empty-state', text: message, attr: { role: this.view.quotaLoading ? 'status' : 'note' } });
			return;
		}

		const used = safeNumber(quota.usedBytes);
		const free = safeNumber(quota.freeBytes);
		const total = used + free;
		const summary = card.createDiv({ cls: 'quark-dashboard-quota-summary' });
		this.renderQuotaMetric(summary, text.used, used, 'quark-dashboard-quota-used');
		this.renderQuotaMetric(summary, text.free, free, 'quark-dashboard-quota-free');
		const progress = card.createEl('progress', { cls: 'quark-dashboard-progress quark-dashboard-quota-progress' });
		progress.max = total > 0 ? total : 1;
		progress.value = Math.min(used, progress.max);
		progress.setAttr('aria-label', `${text.used}: ${formatBytes(used, this.view.language)}; ${text.free}: ${formatBytes(free, this.view.language)}`);
		progress.setAttr('aria-valuetext', `${formatBytes(used, this.view.language)} ${text.used}, ${formatBytes(free, this.view.language)} ${text.free}`);
		card.createEl('p', {
			cls: 'quark-dashboard-quota-scale',
			text: text.quotaScale(formatBytes(total, this.view.language), formatPercent(used, total, this.view.language)),
		});
	}

	private renderQuotaMetric(parent: HTMLElement, label: string, bytes: number, cls: string): void {
		const metric = parent.createDiv({ cls: `quark-dashboard-quota-metric ${cls}` });
		metric.createSpan({ cls: 'quark-dashboard-metric-label', text: label });
		metric.createEl('strong', { cls: 'quark-dashboard-metric-value', text: formatBytes(bytes, this.view.language) });
	}

	private renderBreakdown(parent: HTMLElement, text: DashboardCopy): void {
		const card = this.createCard(parent, 'quark-dashboard-breakdown-card', text.vaultTotal, 'folder');
		const count = this.view.vault.fileCount ?? this.view.vault.byKind.reduce((sum, entry) => sum + safeInteger(entry.files), 0);
		const summary = card.createDiv({ cls: 'quark-dashboard-vault-summary' });
		summary.createEl('strong', { cls: 'quark-dashboard-big-number', text: formatBytes(this.view.vault.totalBytes, this.view.language) });
		summary.createSpan({ cls: 'quark-dashboard-count', text: `${formatInteger(count, this.view.language)} ${text.files}` });
		card.createEl('h4', { cls: 'quark-dashboard-subtitle', text: text.byKind });
		const kinds = Array.from(this.view.vault.byKind)
			.filter((entry) => safeInteger(entry.files) > 0 || safeNumber(entry.bytes) > 0)
			.sort((a, b) => safeNumber(b.bytes) - safeNumber(a.bytes));
		if (kinds.length === 0) {
			card.createEl('p', { cls: 'quark-dashboard-empty-state', text: text.noBreakdown });
			return;
		}
		const maxBytes = Math.max(1, ...kinds.map((entry) => safeNumber(entry.bytes)));
		const list = card.createEl('ul', { cls: 'quark-dashboard-kind-list' });
		const kindPalette = [
			'quark-dashboard-kind-color-purple',
			'quark-dashboard-kind-color-cyan',
			'quark-dashboard-kind-color-green',
			'quark-dashboard-kind-color-orange',
			'quark-dashboard-kind-color-blue',
		];
		for (const [index, entry] of kinds.entries()) {
			const row = list.createEl('li', { cls: `quark-dashboard-kind-row ${kindPalette[index % kindPalette.length]}` });
			const topLine = row.createDiv({ cls: 'quark-dashboard-kind-topline' });
			const label = entry.label?.trim() || entry.kind.trim() || text.unknownKind;
			topLine.createSpan({ cls: 'quark-dashboard-kind-label', text: label });
			topLine.createSpan({ cls: 'quark-dashboard-kind-value', text: `${formatBytes(entry.bytes, this.view.language)} · ${formatInteger(entry.files, this.view.language)} ${text.files}` });
			const progress = row.createEl('progress', { cls: 'quark-dashboard-progress quark-dashboard-kind-progress' });
			progress.max = maxBytes;
			progress.value = Math.min(safeNumber(entry.bytes), maxBytes);
			progress.setAttr('aria-label', `${label}: ${formatBytes(entry.bytes, this.view.language)} (${formatInteger(entry.files, this.view.language)} ${text.files})`);
		}
	}

	private renderSyncActivity(parent: HTMLElement, text: DashboardCopy): void {
		const card = this.createCard(parent, 'quark-dashboard-activity-card', text.latestActivity, 'refresh-cw');
		if (!this.view.latestSync) {
			card.createEl('p', { cls: 'quark-dashboard-empty-state', text: text.noSync });
			return;
		}
		const latest = this.view.latestSync;
		if (latest.at && Number.isFinite(latest.at)) {
			card.createEl('p', { cls: 'quark-dashboard-sync-date', text: text.date(latest.at) });
		}
		const entries: Array<[string, number, string]> = [
			[text.uploaded, safeInteger(latest.uploaded), 'quark-dashboard-activity-uploaded'],
			[text.downloaded, safeInteger(latest.downloaded), 'quark-dashboard-activity-downloaded'],
			[text.deleted, safeInteger(latest.deleted), 'quark-dashboard-activity-deleted'],
			[text.conflicts, safeInteger(latest.conflicts), 'quark-dashboard-activity-conflicts'],
			[text.skipped, safeInteger(latest.skipped), 'quark-dashboard-activity-skipped'],
		];
		const total = entries.reduce((sum, entry) => sum + entry[1], 0);
		const canvas = card.createEl('canvas', { cls: 'quark-dashboard-sync-bar' });
		canvas.width = 900;
		canvas.height = 16;
		canvas.setAttr('role', 'img');
		canvas.setAttr('aria-label', text.lastSyncSummary(
			formatInteger(latest.uploaded, this.view.language),
			formatInteger(latest.downloaded, this.view.language),
			formatInteger(latest.deleted, this.view.language),
			formatInteger(latest.conflicts, this.view.language),
			formatInteger(latest.skipped, this.view.language),
		));
		const context = canvas.getContext('2d');
		if (context) {
			const palette = [
				'--quark-sync-uploaded', '--quark-sync-downloaded', '--quark-sync-deleted',
				'--quark-sync-conflicts', '--quark-sync-skipped',
			];
			const canvasStyle = getComputedStyle(canvas);
			context.fillStyle = canvasStyle.getPropertyValue('--quark-sync-skipped').trim() || '#757a83';
			context.fillRect(0, 0, canvas.width, canvas.height);
			let offset = 0;
			for (const [index, entry] of entries.entries()) {
				const width = total > 0 ? Math.round(canvas.width * entry[1] / total) : 0;
				if (width === 0) continue;
				context.fillStyle = canvasStyle.getPropertyValue(palette[index]).trim() || '#7c6cf0';
				context.fillRect(offset, 0, width, canvas.height);
				offset += width;
			}
		}
		const legend = card.createEl('ul', { cls: 'quark-dashboard-activity-list' });
		for (const [label, value, cls] of entries) {
			const row = legend.createEl('li', { cls: `quark-dashboard-activity-row ${cls}` });
			const header = row.createDiv({ cls: 'quark-dashboard-activity-header' });
			header.createSpan({ cls: 'quark-dashboard-activity-label', text: label });
			header.createEl('strong', { cls: 'quark-dashboard-activity-value', text: formatInteger(value, this.view.language) });
		}
	}

	private renderLargestFiles(text: DashboardCopy): void {
		const card = this.createCard(this.root, 'quark-dashboard-largest-card', text.largestFiles, 'files');
		const files = Array.from(this.view.vault.largestFiles)
			.sort((a, b) => safeNumber(b.bytes) - safeNumber(a.bytes))
			.slice(0, 5);
		if (files.length === 0) {
			card.createEl('p', { cls: 'quark-dashboard-empty-state', text: text.noFiles });
			return;
		}
		const table = card.createEl('table', { cls: 'quark-dashboard-file-table' });
		const head = table.createEl('thead');
		const headerRow = head.createEl('tr');
		headerRow.createEl('th', { cls: 'quark-dashboard-file-rank', text: '#', attr: { scope: 'col' } });
		headerRow.createEl('th', { text: text.pathLabel, attr: { scope: 'col' } });
		headerRow.createEl('th', { cls: 'quark-dashboard-file-type-heading', text: text.type, attr: { scope: 'col' } });
		headerRow.createEl('th', { cls: 'quark-dashboard-file-size-heading', text: text.size, attr: { scope: 'col' } });
		const body = table.createEl('tbody');
		for (const [index, file] of files.entries()) {
			const row = body.createEl('tr');
			row.createEl('td', { cls: 'quark-dashboard-file-rank', text: formatInteger(index + 1, this.view.language) });
			const pathCell = row.createEl('td', { cls: 'quark-dashboard-file-name-cell' });
			if (this.actions.openFile) {
				const fileButton = pathCell.createEl('button', { cls: 'quark-dashboard-file-link', text: file.path });
				fileButton.type = 'button';
				fileButton.setAttr('title', file.path);
				fileButton.setAttr('aria-label', `${file.name || file.path} (${text.path}: ${file.path})`);
				fileButton.addEventListener('click', () => this.runFileAction(file.path));
			} else {
				pathCell.createSpan({ cls: 'quark-dashboard-file-name', text: file.path, attr: { title: file.path } });
			}
			const typeCell = row.createEl('td', { cls: 'quark-dashboard-file-type' });
			typeCell.createSpan({ cls: `quark-dashboard-file-type-chip ${fileTypeClass(file.path)}`, text: text.fileType(file.path) });
			row.createEl('td', { cls: 'quark-dashboard-file-size', text: formatBytes(file.bytes, this.view.language) });
		}
	}

	private renderSecondaryActions(text: DashboardCopy): void {
		const actions = this.root.createDiv({ cls: 'quark-dashboard-secondary-actions', attr: { role: 'group', 'aria-label': this.view.language === 'en' ? 'Account tools' : '账号工具' } });
		this.optionalActionButton(actions, text.login, 'login', 'user-round');
		this.optionalActionButton(actions, text.exportPairing, 'exportPairing', 'cloud-upload');
		this.optionalActionButton(actions, text.importPairing, 'importPairing', 'cloud-download');
		this.optionalActionButton(actions, text.logout, 'logout', 'log-out');
		if (this.view.latestSync || this.view.skippedDetails) {
			const details = this.makeButton(actions, text.lastSync, 'quark-dashboard-secondary-button', 'history', () => {
				this.skippedExpanded = !this.skippedExpanded;
				this.render();
			});
			details.setAttr('aria-expanded', String(this.skippedExpanded));
		}
	}

	private renderInlinePlan(text: DashboardCopy): void {
		const inline = this.view.inline;
		if (!inline) return;
		const plan = inline.plan;
		const panel = this.root.createDiv({ cls: 'quark-dashboard-plan' });
		const heading = panel.createDiv({ cls: 'quark-dashboard-plan-heading' });
		const title = heading.createEl('h3', { cls: 'quark-dashboard-section-title' });
		const icon = title.createSpan({ cls: 'quark-dashboard-section-icon' });
		setIcon(icon, 'list-checks');
		title.createSpan({ text: text.planTitle });
		const status = plan.events.length || plan.paths.length || plan.skipped.length
			? inline.confirm ? text.planInitial : text.planReadOnly
			: text.planNoPaths;
		panel.createEl('p', { cls: 'quark-dashboard-plan-description', text: status });
		panel.createEl('p', {
			cls: 'quark-dashboard-plan-summary',
			text: text.planSummary(
				formatInteger(plan.events.length, this.view.language),
				formatInteger(plan.paths.length, this.view.language),
				formatInteger(plan.skipped.length, this.view.language),
			),
		});
		this.renderPlanPaths(panel, text, plan);
		const buttons = panel.createDiv({ cls: 'quark-dashboard-plan-actions' });
		if (inline.confirm) {
			const confirm = this.makeButton(buttons, text.confirmSync, 'quark-dashboard-button-primary', 'check', () => this.runAction('confirmSync'));
			confirm.toggleAttribute('disabled', this.view.busy || !this.actions.confirmSync);
		}
		const dismiss = this.makeButton(buttons, text.dismiss, 'quark-dashboard-button-secondary', 'x', () => this.runAction('dismissPlan'));
		dismiss.toggleAttribute('disabled', this.view.busy || !this.actions.dismissPlan);
	}

	private renderPlanPaths(parent: HTMLElement, text: DashboardCopy, plan: SyncPlan): void {
		const paths = parent.createDiv({ cls: 'quark-dashboard-plan-paths' });
		const title = paths.createEl('h4', { cls: 'quark-dashboard-subtitle', text: `${text.planPaths} · ${formatInteger(plan.paths.length, this.view.language)}` });
		title.setAttr('aria-label', text.planPaths);
		if (plan.paths.length === 0) {
			paths.createEl('p', { cls: 'quark-dashboard-empty-state', text: text.planNoPaths });
		} else {
			const list = paths.createEl('ul', { cls: 'quark-dashboard-plan-list' });
			for (const item of plan.paths.slice(0, 5)) {
				const row = list.createEl('li', { cls: 'quark-dashboard-plan-row' });
				row.createEl('code', { cls: 'quark-dashboard-plan-path', text: item.path, attr: { title: item.path } });
				const action = item.result.deleted ? text.planDeleted : item.result.winner ? text.planApply : text.planNoFinal;
				const conflicts = item.result.conflictCopies.length;
				row.createSpan({ cls: 'quark-dashboard-plan-result', text: conflicts ? `${action} · ${text.planConflicts(formatInteger(conflicts, this.view.language))}` : action });
			}
			if (plan.paths.length > 5) list.createEl('li', { cls: 'quark-dashboard-plan-more', text: text.planMore(formatInteger(plan.paths.length - 5, this.view.language)) });
		}
		if (plan.skipped.length > 0) {
			paths.createEl('h4', { cls: 'quark-dashboard-subtitle', text: `${text.planSkipped} · ${formatInteger(plan.skipped.length, this.view.language)}` });
			const skipped = paths.createEl('ul', { cls: 'quark-dashboard-plan-list quark-dashboard-plan-skipped' });
			for (const item of plan.skipped.slice(0, 3)) {
				const row = skipped.createEl('li', { cls: 'quark-dashboard-plan-row' });
				row.createEl('code', { cls: 'quark-dashboard-plan-path', text: item.path, attr: { title: item.path } });
				row.createSpan({ cls: 'quark-dashboard-plan-result', text: item.reason });
			}
			if (plan.skipped.length > 3) skipped.createEl('li', { cls: 'quark-dashboard-plan-more', text: text.planMore(formatInteger(plan.skipped.length - 3, this.view.language)) });
		}
	}

	private renderSkippedDetails(text: DashboardCopy): void {
		const panel = this.root.createDiv({ cls: 'quark-dashboard-skipped-details' });
		panel.createEl('h3', { cls: 'quark-dashboard-section-title', text: text.skippedDetails });
		const latest = this.view.latestSync;
		if (latest) {
			if (latest.at && Number.isFinite(latest.at)) panel.createEl('p', { cls: 'quark-dashboard-sync-date', text: text.date(latest.at) });
			panel.createEl('p', {
				cls: 'quark-dashboard-plan-summary',
				text: text.lastSyncSummary(
					formatInteger(latest.uploaded, this.view.language),
					formatInteger(latest.downloaded, this.view.language),
					formatInteger(latest.deleted, this.view.language),
					formatInteger(latest.conflicts, this.view.language),
					formatInteger(latest.skipped, this.view.language),
				),
			});
		}
		const skipped = this.view.skippedDetails ?? [];
		if (skipped.length === 0) {
			panel.createEl('p', { cls: 'quark-dashboard-empty-state', text: text.skippedEmpty });
			return;
		}
		const list = panel.createEl('ul', { cls: 'quark-dashboard-skipped-list' });
		for (const item of skipped) {
			const row = list.createEl('li');
			row.createEl('code', { text: item.path });
			row.createSpan({ text: item.reason });
		}
	}

	private createCard(parent: HTMLElement, cls: string, title: string, iconName: string): HTMLDivElement {
		const card = parent.createDiv({ cls: `quark-dashboard-card ${cls}` });
		const heading = card.createEl('h3', { cls: 'quark-dashboard-card-title' });
		const icon = heading.createSpan({ cls: 'quark-dashboard-card-icon' });
		setIcon(icon, iconName);
		heading.createSpan({ text: title });
		return card;
	}

	private actionButton(parent: HTMLElement, label: string, cls: string, action: DashboardActionName, icon: string, requiresAccount = false, allowSignedOut = false): HTMLButtonElement {
		const button = this.makeButton(parent, label, cls, icon, () => this.runAction(action));
		const callback = this.actions[action];
		button.toggleAttribute('disabled', this.view.busy || typeof callback !== 'function' || (requiresAccount && this.view.account.status !== 'connected') || (!allowSignedOut && action === 'checkConnection' && this.view.account.status === 'signed-out'));
		return button;
	}

	private optionalActionButton(parent: HTMLElement, label: string, action: DashboardActionName, icon: string): void {
		if (!this.actions[action]) return;
		this.actionButton(parent, label, 'quark-dashboard-secondary-button', action, icon, action === 'exportPairing');
	}

	private makeButton(parent: HTMLElement, label: string, cls: string, icon: string, onClick: () => void): HTMLButtonElement {
		const button = parent.createEl('button', { cls });
		button.type = 'button';
		const iconEl = button.createSpan({ cls: 'quark-dashboard-button-icon' });
		setIcon(iconEl, icon);
		button.createSpan({ text: label });
		button.addEventListener('click', onClick);
		return button;
	}

	private runAction(action: DashboardActionName): void {
		const callback = this.actions[action];
		if (this.view.busy || typeof callback !== 'function') return;
		this.runValueAction(() => callback());
	}

	private runValueAction(callback: () => void | Promise<void>, onFailure?: () => void): void {
		try {
			const result = callback();
			if (result) void Promise.resolve(result).catch(() => {
				new Notice(copy[this.view.language].actionFailed);
				onFailure?.();
			});
		} catch {
			new Notice(copy[this.view.language].actionFailed);
			onFailure?.();
		}
	}

	private runFileAction(path: string): void {
		const callback = this.actions.openFile;
		if (this.view.busy || !callback) return;
		try {
			const result = callback(path);
			if (result) void Promise.resolve(result).catch(() => new Notice(copy[this.view.language].fileOpenFailed));
		} catch {
			new Notice(copy[this.view.language].fileOpenFailed);
		}
	}

	private accountStateLabel(text: DashboardCopy): string {
		if (this.view.account.status === 'connected') return this.view.account.label || text.connected;
		if (this.view.account.status === 'expired') return text.expired;
		return text.signedOut;
	}
}

function safeNumber(value: number): number {
	return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function safeInteger(value: number): number {
	return Math.floor(safeNumber(value));
}

function formatInteger(value: number, language: DashboardLanguage): string {
	return new Intl.NumberFormat(language === 'en' ? 'en' : 'zh-CN', { maximumFractionDigits: 0 }).format(safeInteger(value));
}

function formatPercent(used: number, total: number, language: DashboardLanguage): string {
	const fraction = total > 0 ? Math.min(safeNumber(used) / safeNumber(total), 1) : 0;
	return new Intl.NumberFormat(language === 'en' ? 'en' : 'zh-CN', {
		style: 'percent',
		maximumFractionDigits: 1,
	}).format(fraction);
}

function formatBytes(value: number, language: DashboardLanguage): string {
	const bytes = safeNumber(value);
	if (bytes < 1024) return `${formatInteger(bytes, language)} B`;
	const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
	let size = bytes / 1024;
	let index = 0;
	while (size >= 1024 && index < units.length - 1) {
		size /= 1024;
		index += 1;
	}
	return `${new Intl.NumberFormat(language === 'en' ? 'en' : 'zh-CN', { maximumFractionDigits: size < 10 ? 1 : 0 }).format(size)} ${units[index]}`;
}

function getExtension(path: string): string {
	const name = path.split('/').pop() ?? path;
	const dot = name.lastIndexOf('.');
	return dot > -1 ? name.slice(dot + 1).toLowerCase() : '';
}

function fileTypeLabel(path: string, language: DashboardLanguage): string {
	const extension = getExtension(path);
	if (extension === 'md' || extension === 'markdown') return language === 'en' ? 'Notes' : '笔记';
	if (extension === 'pdf') return 'PDF';
	if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tif', 'tiff'].includes(extension)) return language === 'en' ? 'Image' : '图片';
	if (['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'mp4', 'mov', 'mkv', 'webm'].includes(extension)) return language === 'en' ? 'Media' : '音视频';
	if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'csv'].includes(extension)) return language === 'en' ? 'Document' : '文档';
	return language === 'en' ? 'Other' : '其他';
}

function fileTypeClass(path: string): string {
	const extension = getExtension(path);
	if (extension === 'md' || extension === 'markdown') return 'is-note';
	if (extension === 'pdf') return 'is-pdf';
	if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tif', 'tiff'].includes(extension)) return 'is-image';
	if (['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'mp4', 'mov', 'mkv', 'webm'].includes(extension)) return 'is-media';
	if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'csv'].includes(extension)) return 'is-document';
	return 'is-other';
}
