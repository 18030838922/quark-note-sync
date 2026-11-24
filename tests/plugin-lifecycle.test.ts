import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSync } from 'esbuild';
import type QuarkNoteSyncPlugin from '../src/main.ts';
import type { QuarkDashboardActions, QuarkDashboardView } from '../src/dashboard.ts';

const bundle = buildSync({
	entryPoints: ['src/main.ts'],
	bundle: true,
	format: 'cjs',
	platform: 'browser',
	external: ['obsidian', 'electron'],
	write: false,
}).outputFiles[0].text;

type TextNode = { text?: string; children: TextNode[]; empty: () => void; createEl: (tag: string, options?: { text?: string }) => TextNode; createDiv: () => TextNode };

function createTextNode(text?: string): TextNode {
	const children: TextNode[] = [];
	const createChild = (value?: string) => { const child = createTextNode(value); children.push(child); return child; };
	return { text, children, empty: () => { children.length = 0; },
		createEl: (tag, options) => {
			assert.notEqual(tag, 'h2', 'plugin settings must use the Obsidian heading component');
			return createChild(options?.text);
		}, createDiv: () => createChild() };
}

function renderedText(node: TextNode): string[] {
	return [node.text ?? '', ...node.children.flatMap(renderedText)];
}

async function loadPlugin(data: object, savedCookie: string | null = 'sid=fixture', platform: 'desktop' | 'ios' | 'android' = 'desktop') {
	const notices: string[] = [];
	let settingsTab!: { display(): void; containerEl: TextNode };
	let changeLanguage!: (value: string) => Promise<void>;
	class SettingsTab { containerEl = createTextNode(); }
	class Setting {
		private row: TextNode;
		constructor(container: TextNode) { this.row = container.createDiv(); }
		setName(text: string) { this.row.createEl('label', { text }); return this; }
		setHeading() { return this; }
		setDesc(text: string) { this.row.createEl('p', { text }); return this; }
		addButton(render: (button: unknown) => void) {
			const row = this.row;
			render({
				setButtonText(text: string) { row.createEl('button', { text }); return this; },
				setCta() { return this; }, setDisabled() { return this; }, onClick() { return this; },
			});
			return this;
		}
		addText(render: (input: unknown) => void) {
			render({
				inputEl: { setAttribute() {} }, setPlaceholder() { return this; },
				setValue() { return this; }, setDisabled() { return this; },
			});
			return this;
		}
		addToggle(render: (toggle: unknown) => void) {
			render({ setValue() { return this; }, setDisabled() { return this; }, onChange() { return this; } });
			return this;
		}
		addDropdown(render: (dropdown: unknown) => void) {
			render({
				addOption() { return this; }, setValue() { return this; }, setDisabled() { return this; },
				onChange(callback: typeof changeLanguage) { changeLanguage = callback; return this; },
			});
			return this;
		}
	}
	const commands = new Map<string, { callback?: () => void; checkCallback?: (checking: boolean) => boolean }>();
	const workspaceEvents = new Map<string, (...args: unknown[]) => void>();
	const protocolHandlers = new Map<string, (params: Record<string, string>) => void>();
	const readyCallbacks: Array<() => void> = [];
	const sideRequests: Array<{ type: string; side: string; reveal?: boolean }> = [];
	type Sidebar = { actions: QuarkDashboardActions; view: QuarkDashboardView };
	let factory: ((leaf: object) => Sidebar) | undefined;
	let sidebarLeaf: { view?: Sidebar } | undefined;
	let revealed = 0;
	let modalOpens = 0;
	const intervals = new Map<number, () => void>();
	let nextInterval = 0;
	const state: Record<string, unknown> = { ...data, deviceId: 'test-device' };
	let cookie = savedCookie;
	let requestStatus = 200;
	let requests = 0;
	let quotaRequests = 0;
	const app = {
		workspace: {
			on: (name: string, callback: (...args: unknown[]) => void) => { workspaceEvents.set(name, callback); return { name, callback }; },
			onLayoutReady: (callback: () => void) => readyCallbacks.push(callback),
			getActiveViewOfType: () => null,
			getLeavesOfType: () => sidebarLeaf ? [sidebarLeaf] : [],
			async ensureSideLeaf(type: string, side: string, options: { reveal?: boolean }) {
				sideRequests.push({ type, side, reveal: options.reveal });
				return sidebarLeaf ??= {};
			},
			async revealLeaf(leaf: { view?: Sidebar }) {
				revealed += 1;
				leaf.view ??= factory?.(leaf);
			},
		},
		secretStorage: {
			getSecret: () => cookie,
			setSecret: (_id: string, value: string) => { cookie = value || null; },
		},
		vault: {
			configDir: '.obsidian',
			getName: () => 'Test vault',
			getFiles: () => [{ path: 'Notes/Test.md', extension: 'md', stat: { size: 42 } }],
			on: (name: string, callback: (...args: unknown[]) => void) => ({ name, callback }),
		},
	};
	class Plugin {
		app = app;
		async loadData() { return state; }
		async saveData(value: object) { Object.assign(state, value); }
		addRibbonIcon() {}
		registerView(type: string, createView: typeof factory) { if (type === 'quark-note-sync-dashboard') factory = createView; }
		addSettingTab(tab: typeof settingsTab) { settingsTab = tab; }
		addCommand(command: { id: string; callback?: () => void; checkCallback?: (checking: boolean) => boolean }) {
			commands.set(command.id, command);
		}
		registerEvent(event: { name?: string; callback?: (...args: unknown[]) => void }) {
			if (event.name && event.callback) workspaceEvents.set(event.name, event.callback);
		}
		registerMarkdownPostProcessor() {}
		registerEditorExtension() {}
		registerObsidianProtocolHandler(action: string, handler: (params: Record<string, string>) => void) {
			protocolHandlers.set(action, handler);
		}
	}
	const obsidian = {
		Plugin,
		MarkdownView: class {},
		MarkdownRenderChild: class {},
		PluginSettingTab: SettingsTab,
		Setting,
		ItemView: class {
			containerEl = { addClass() {} };
			contentEl = { addClass() {}, createDiv: () => ({}) };
		},
		Modal: class { open() { modalOpens += 1; } close() {} },
		setIcon() {},
		Notice: class { constructor(message: string) { notices.push(message); } },
		Platform: {
			isDesktopApp: platform === 'desktop',
			isMobileApp: platform !== 'desktop',
			isIosApp: platform === 'ios',
			isAndroidApp: platform === 'android',
		},
	};
	const window = {
		setInterval(callback: () => void) { intervals.set(++nextInterval, callback); return nextInterval; },
		clearInterval(id: number) { intervals.delete(id); },
	};
	const module = { exports: {} };
	const requireExternal = (name: string) => {
		assert.equal(name, 'obsidian');
		return obsidian;
	};
	new Function('module', 'exports', 'require', 'window', bundle)(module, module.exports, requireExternal, window);
	const { default: PluginClass } = module.exports as { default: new () => QuarkNoteSyncPlugin };
	const plugin = new PluginClass();
	Object.assign(plugin, {
		createTransport: () => ({
			async request(request: { url: string }) {
				requests += 1;
				if (requestStatus === 0) throw new Error('offline');
				const url = new URL(request.url);
				if (url.pathname === '/1/clouddrive/member') {
					quotaRequests += 1;
					return { status: requestStatus, headers: {}, text: () =>
						JSON.stringify({ code: 0, data: { total_capacity: 1000, use_capacity: 250 } }) };
				}
				const pdirFid = url.searchParams.get('pdir_fid');
				const list = pdirFid === '0' ? [{ fid: 'root-1', file_name: 'Obsidian Notes', file_type: 0, dir: true }] : [];
				const body = url.pathname === '/account/info'
					? { code: 0, data: { uid: 'account-12345', nickname: '测试昵称' } }
					: { code: 0, data: { list }, metadata: { _total: list.length } };
				return { status: requestStatus, headers: {}, text: () => JSON.stringify(body) };
			},
		}),
	});
	await plugin.onload();
	return {
		plugin, state, commands, notices, intervals,
		workspaceEvents, protocolHandlers,
		fireLayoutReady: () => readyCallbacks.forEach((callback) => callback()),
		setRequestStatus: (status: number) => { requestStatus = status; },
		requestCount: () => requests,
		quotaRequestCount: () => quotaRequests,
		sideRequests, revealedCount: () => revealed, modalCount: () => modalOpens,
		readSidebar: () => sidebarLeaf?.view,
		showSettings: () => settingsTab.display(),
		settingsText: () => renderedText(settingsTab.containerEl),
		switchLanguage: (value: string) => changeLanguage(value),
		savedCookie: () => cookie,
	};
}

test('startup sync runs once after layout readiness even with periodic sync disabled', async () => {
	const fixture = await loadPlugin({ syncOnStartup: true, initialSyncCompleted: true });
	let syncs = 0;
	Object.assign(fixture.plugin, { createService: () => ({
		async sync() {
			syncs += 1;
			return { uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0, skipped: [] };
		},
	}) });
	assert.equal(syncs, 0);
	assert.equal(fixture.intervals.size, 0);
	fixture.fireLayoutReady();
	await new Promise<void>((resolve) => setImmediate(resolve));
	fixture.fireLayoutReady();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(syncs, 1);
});

test('startup sync makes no requests before first-sync confirmation or without a session', async () => {
	for (const [confirmed, cookie] of [[false, 'sid=fixture'], [true, null]] as const) {
		const fixture = await loadPlugin({ syncOnStartup: true, initialSyncCompleted: confirmed }, cookie);
		fixture.fireLayoutReady();
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(fixture.requestCount(), 0);
		assert.deepEqual(fixture.notices, []);
	}
});

test('account actions distinguish authentication rejection from offline errors and preserve history on logout', async () => {
	const fixture = await loadPlugin({
		boundAccountId: 'account-12345', boundRootFid: 'root-1', initialSyncCompleted: true, autoSync: true,
	});
	const { plugin } = fixture;
	const readAccount = () => plugin.accountView;
	const qrAvailable = () => fixture.commands.get('quark-qr-login')?.checkCallback?.(true);
	assert.equal(readAccount().state, 'connected');
	assert.equal(qrAvailable(), false);

	await plugin.checkConnection();
	assert.deepEqual(readAccount(), { state: 'connected', label: '测试昵称' });
	fixture.setRequestStatus(0);
	await plugin.checkConnection();
	assert.equal(readAccount().state, 'connected');
	assert.equal(qrAvailable(), false);
	fixture.setRequestStatus(401);
	await plugin.checkConnection();
	assert.equal(readAccount().state, 'expired');
	assert.equal(qrAvailable(), true);
	assert.equal(fixture.intervals.size, 0);
	assert.equal(fixture.state.sessionExpired, true);

	fixture.setRequestStatus(200);
	await plugin.saveCookie('sid=replacement');
	assert.equal(readAccount().state, 'connected');
	assert.equal(qrAvailable(), false);
	assert.equal(fixture.state.sessionExpired, false);
	assert.equal(fixture.intervals.size, 1);

	await plugin.signOut();
	assert.equal(readAccount().state, 'signed-out');
	assert.equal(fixture.savedCookie(), null);
	assert.equal(fixture.state.boundRootFid, 'root-1');
	assert.equal(plugin.isFirstSyncComplete, true);
});

test('startup sync is off by default and can be persisted independently', async () => {
	const fixture = await loadPlugin({ initialSyncCompleted: true });
	fixture.fireLayoutReady();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(fixture.requestCount(), 0);
	await fixture.plugin.setSyncOnStartup(true);
	assert.equal(fixture.state.syncOnStartup, true);
	assert.equal(fixture.state.autoSync, false);
	assert.equal(fixture.intervals.size, 0);
});


test('settings display Chinese by default, switch immediately, and remember the selected language', async () => {
	const fixture = await loadPlugin({}, null);
	fixture.showSettings();
	assert.ok(fixture.settingsText().includes('夸克笔记同步'));
	assert.ok(fixture.settingsText().includes('扫码登录'));
	await fixture.switchLanguage('en');
	assert.equal(fixture.state.language, 'en');
	assert.ok(fixture.settingsText().includes('Sign in with QR code'));
	assert.ok(!fixture.settingsText().includes('扫码登录'));

	const reopened = await loadPlugin(fixture.state, null);
	reopened.showSettings();
	assert.ok(reopened.settingsText().includes('Sync now'));
	await reopened.switchLanguage('zh-CN');
	assert.equal(reopened.state.language, 'zh-CN');
	assert.ok(reopened.settingsText().includes('立即同步夸克'));
});



test('the dashboard is registered on the left and reveals a single tab', async () => {
	const loggedIn = await loadPlugin({});
	loggedIn.fireLayoutReady();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(loggedIn.sideRequests, [{ type: 'quark-note-sync-dashboard', side: 'left', reveal: false }]);
	assert.equal(loggedIn.quotaRequestCount(), 0);
	assert.equal(loggedIn.revealedCount(), 0);

	const open = loggedIn.commands.get('open-dashboard')?.callback;
	assert.ok(open);
	open();
	open();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(loggedIn.revealedCount(), 1);
	assert.equal(loggedIn.sideRequests.length, 1);
	assert.equal(loggedIn.quotaRequestCount(), 1);

	const loggedOut = await loadPlugin({}, null);
	await loggedOut.plugin.openDashboard();
	assert.equal(loggedOut.requestCount(), 0);
});

test('first sync uses the sidebar preview and cannot run until confirmed there', async () => {
	const fixture = await loadPlugin({});
	let previewCalls = 0;
	let syncCalls = 0;
	const plan = { events: [], paths: [], skipped: [], nextSnapshots: {} };
	Object.assign(fixture.plugin, { createService: () => ({
		async preview() { previewCalls += 1; return plan; },
		async sync() {
			syncCalls += 1;
			return { uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0, skipped: [] };
		},
	}) });
	await fixture.plugin.openDashboard();
	await fixture.readSidebar()?.actions.preview?.();
	await fixture.readSidebar()?.actions.confirmSync?.();
	assert.equal(syncCalls, 0);
	await fixture.readSidebar()?.actions.sync?.();
	assert.equal(previewCalls, 2);
	assert.equal(syncCalls, 0);
	assert.equal(fixture.readSidebar()?.view.inline?.confirm, true);
	await fixture.readSidebar()?.actions.confirmSync?.();
	assert.equal(syncCalls, 1);
	assert.equal(fixture.state.initialSyncCompleted, true);
	assert.equal(fixture.readSidebar()?.view.inline, undefined);
	assert.equal(fixture.modalCount(), 0);
});


test('iOS and Android can open QR login without a desktop pairing code', async () => {
	for (const [platform, deviceName] of [['ios', 'iOS'], ['android', 'Android']] as const) {
		const fixture = await loadPlugin({}, null, platform);
		fixture.showSettings();
		assert.equal(fixture.plugin.deviceName, deviceName);
		assert.ok(fixture.settingsText().includes('导入电脑授权'));
		assert.ok(fixture.settingsText().includes('扫码登录'));
		const command = fixture.commands.get('quark-qr-login')?.checkCallback;
		assert.equal(command?.(true), true);
		assert.equal(fixture.modalCount(), 0);
		assert.equal(command?.(false), true);
		assert.equal(fixture.modalCount(), 1);
	}
});

test('Quark Drive browse command and public editor menu are registered', async () => {
	const fixture = await loadPlugin({});
	assert.ok(fixture.commands.has('browse-quark-drive'));
	assert.ok(fixture.protocolHandlers.has('quark-note'));
	assert.equal(typeof fixture.workspaceEvents.get('editor-menu'), 'function');
	const titles: string[] = [];
	const menu = {
		addItem(callback: (item: unknown) => void) {
			callback({
				setTitle(title: string) { titles.push(title); return this; },
				setIcon() { return this; },
				onClick() { return this; },
			});
			return this;
		},
	};
	fixture.workspaceEvents.get('editor-menu')?.(menu, {
		getSelection: () => '', getCursor: () => ({ line: 0, ch: 0 }), getLine: () => '',
	}, {});
	assert.ok(titles.some((title) => /夸克|Quark/.test(title)));
});
