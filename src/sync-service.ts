import type { App } from 'obsidian';
import { validatePathSet, type VersionEvent } from './core.ts';
import { sha256Hex } from './hash.ts';
import { LocalVaultAdapter, CONFLICT_DIRECTORY, type LocalScan } from './local-vault.ts';
import { createBatchManifest, parseBatchManifest } from './manifest.ts';
import { QuarkAuthenticationError, QuarkClient } from './quark-api.ts';
import { buildSyncPlan, type SyncPlan, type SyncSnapshot } from './sync-engine.ts';
import { recoverPendingApply } from './core.ts';
import { applyIfCurrentHash } from './safe-apply.ts';
import { managedDownloadPaths, type SourceIndex } from './source-index.ts';
import { selectSyncScope, type ScopeSelection, type SyncScope } from './sync-scope.ts';

const CLOUD_DATA_DIRECTORY = 'Obsidian Sync Data';
const CLOUD_BLOB_DIRECTORY = 'blobs';
const CLOUD_EVENT_DIRECTORY = 'events';
const MANIFEST_NAME = /^[a-f\d]{64}\.json$/i;
const TARGET_MANIFEST_BATCH_BYTES = 5 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 10 * 1024 * 1024;

export interface SyncSettingsView {
	cloudDirectoryName: string;
	syncScope?: SyncScope;
}

export interface PendingApplyState {
	beforeHash: string | null;
	desiredHash: string | null;
	heads: string[];
}

export interface SyncStatePort {
	deviceId: string;
	snapshots: Record<string, SyncSnapshot>;
	pendingApplies: Record<string, PendingApplyState>;
	sourceIndex?: SourceIndex;
	persist(): Promise<void>;
}

export interface SyncSummary {
	uploaded: number;
	downloaded: number;
	deleted: number;
	conflicts: number;
	skipped: Array<{ path: string; reason: string; retryable?: boolean }>;
}

export interface SyncProgress {
	path: string;
	phase: 'upload' | 'download' | 'apply';
	bytes?: number;
	total?: number;
}

interface CloudLayout {
	rootFid: string;
	vaultId: string;
	dataFid?: string;
	blobsFid?: string;
	eventsFid?: string;
	deviceFid?: string;
}

interface RemoteContext {
	layout?: CloudLayout;
	events: VersionEvent[];
}

export class QuarkSyncService {
	private readonly app: App;
	private readonly client: QuarkClient;
	private readonly settings: SyncSettingsView;
	private readonly state: SyncStatePort;
	private readonly local: LocalVaultAdapter;

	constructor(app: App, client: QuarkClient, settings: SyncSettingsView, state: SyncStatePort) {
		this.app = app;
		this.client = client;
		this.settings = settings;
		this.state = state;
		this.local = new LocalVaultAdapter(app);
	}

	async preview(): Promise<SyncPlan> {
		await this.client.checkConnection();
		const { events } = await this.readRemoteContext();
		return await this.makePlan(events, this.excludedPaths(events));
	}

	async previewScope(scope: SyncScope): Promise<ScopeSelection> {
		await this.client.checkConnection();
		const { events } = await this.readRemoteContext();
		return this.selectScope(scope, events);
	}

	async versionHistory(): Promise<VersionEvent[]> {
		await this.client.checkConnection();
		return (await this.readRemoteContext()).events;
	}

	async readHistoricalVersion(event: VersionEvent): Promise<Uint8Array> {
		await this.client.checkConnection();
		const { layout } = await this.readRemoteContext(undefined, false);
		const folder = layout?.dataFid ? await this.client.findChildByName(layout.dataFid, CLOUD_BLOB_DIRECTORY) : undefined;
		if (!layout || !folder?.isDirectory) throw new Error('夸克同步内容目录不存在');
		return await this.downloadBlob({ ...layout, blobsFid: folder.fid }, event);
	}

	async sync(selectedPath?: string, progress?: (state: SyncProgress) => void): Promise<SyncSummary> {
		await this.client.checkConnection();
		const layout = await this.ensureCloudLayout();
		const { events } = await this.readRemoteContext(layout);
		const excluded = this.excludedPaths(events);
		await this.recoverPendingApplies(excluded, selectedPath);
		const plan = await this.makePlan(events, excluded);
		const selected = (path: string) => selectedPath === undefined || path === selectedPath;
		const skipped: SyncSummary['skipped'] = plan.skipped.filter((item) => selected(item.path));
		if (selectedPath && excluded.has(selectedPath)) skipped.push({ path: selectedPath, reason: '此设备的同步范围已排除此文件' });
		let uploaded = 0;
		let downloaded = 0;
		let deleted = 0;
		let conflicts = 0;

		const failedUploads = new Set<string>();
		const batches = splitEvents(plan.events.filter((event) => selected(event.path)), TARGET_MANIFEST_BATCH_BYTES);
		for (const batch of batches) {
			const ready: VersionEvent[] = [];
			for (const event of batch) {
				if (event.kind === 'file') {
					try {
						progress?.({ path: event.path, phase: 'upload', bytes: 0, total: event.size });
						const content = await this.local.read(event.path);
						if (!content || content.bytes.byteLength !== event.size || content.sha256 !== event.sha256) {
							throw new Error('本地文件在上传前发生变化');
						}
						await this.ensureBlob(layout.blobsFid!, event.sha256, event.size, content.bytes, (bytes) => {
							progress?.({ path: event.path, phase: 'upload', bytes, total: event.size });
						});
					} catch (error) {
						if (error instanceof QuarkAuthenticationError) throw error;
						failedUploads.add(event.path);
						skipped.push({ path: event.path, reason: safeError(error), retryable: true });
						continue;
					}
				}
				ready.push(event);
			}
			if (!ready.length) continue;
			await this.publishBatch(layout, ready);
			this.acknowledgeLocalEvents(ready);
			await this.state.persist();
			uploaded += ready.filter((event) => event.kind === 'file').length;
		}

		for (const pathPlan of plan.paths) {
			if (!selected(pathPlan.path) || failedUploads.has(pathPlan.path)) continue;
			try {
				progress?.({ path: pathPlan.path, phase: 'apply' });
				const result = await this.applyPath(layout, pathPlan, progress);
				if (result === 'downloaded') downloaded += 1;
				if (result === 'deleted') deleted += 1;
				if (result !== 'skipped') conflicts += pathPlan.result.conflictCopies.length;
				if (result === 'skipped') {
					skipped.push({ path: pathPlan.path, reason: '本地文件在同步期间发生变化，已保留并跳过覆盖', retryable: true });
				}
			} catch (error) {
				if (error instanceof QuarkAuthenticationError) throw error;
				skipped.push({ path: pathPlan.path, reason: safeError(error), retryable: true });
			}
		}
		return { uploaded, downloaded, deleted, conflicts, skipped: dedupeSkipped(skipped) };
	}

	private selectScope(scope: SyncScope, events: VersionEvent[]): ScopeSelection {
		const configDir = this.app.vault.configDir;
		const managed = new Set([...this.managedPaths()].map(pathKey));
		const check = (path: string) => {
			if (managed.has(pathKey(path))) return false;
			try {
				validatePathSet([path], configDir);
				return true;
			} catch { return false; }
		};
		const local = this.app.vault.getFiles().filter((file) => check(file.path)).map((file) => ({ path: file.path, size: file.stat.size }));
		const savedPaths = [...Object.keys(this.state.snapshots), ...Object.keys(this.state.pendingApplies)].filter(check);
		return selectSyncScope(scope, local, events.filter((event) => check(event.path)), savedPaths);
	}

	private excludedPaths(events: VersionEvent[]): Set<string> {
		const scope = this.settings.syncScope;
		if (!scope || (!scope.folders.length && !scope.extensions.length && scope.maxBytes === null)) return new Set();
		return new Set(this.selectScope(scope, events).excluded);
	}

	private async makePlan(remoteEvents: VersionEvent[], excluded: ReadonlySet<string>): Promise<SyncPlan> {
		const managedPaths = this.managedPaths();
		const excludedKeys = new Set([...excluded].map(pathKey));
		const scan: LocalScan = await this.local.scan(this.app.vault.configDir, new Set([...managedPaths, ...excluded]));
		return await buildSyncPlan({
			localFiles: scan.files,
			presentPaths: scan.presentPaths,
			protectedPaths: scan.protectedPaths,
			snapshots: Object.fromEntries(Object.entries(this.state.snapshots).filter(([path]) => !excludedKeys.has(pathKey(path)))),
			remoteEvents: remoteEvents.filter((event) => !excludedKeys.has(pathKey(event.path))),
			managedPaths: [...managedPaths],
			deviceId: this.state.deviceId,
			now: Date.now(),
			configDir: this.app.vault.configDir,
		});
	}

	private managedPaths(): Set<string> {
		return managedDownloadPaths(this.state.sourceIndex ?? Object.create(null) as SourceIndex);
	}

	private async readRemoteContext(existingLayout?: CloudLayout, loadEvents = true): Promise<RemoteContext> {
		let layout = existingLayout;
		if (!layout) {
			const root = await this.client.findChildByName('0', this.settings.cloudDirectoryName);
			if (!root) return { events: [] };
			if (!root.isDirectory) throw new Error('夸克云端目录名被文件占用');
			const vaultId = await sha256Hex(new TextEncoder().encode(`quark-vault:${root.fid}`));
			layout = { rootFid: root.fid, vaultId };
		}
		if (!layout.eventsFid) {
			const data = await this.client.findChildByName(layout.rootFid, CLOUD_DATA_DIRECTORY);
			if (!data) return { layout, events: [] };
			if (!data.isDirectory) throw new Error('夸克同步数据目录被文件占用');
			layout.dataFid = data.fid;
			const events = await this.client.findChildByName(data.fid, CLOUD_EVENT_DIRECTORY);
			if (!events) return { layout, events: [] };
			if (!events.isDirectory) throw new Error('夸克事件目录被文件占用');
			layout.eventsFid = events.fid;
		}
		const events = loadEvents ? await this.readAllEvents(layout) : [];
		return { layout, events };
	}

	private async ensureCloudLayout(): Promise<CloudLayout> {
		const rootFid = await this.client.ensureFolder('0', this.settings.cloudDirectoryName);
		const vaultId = await sha256Hex(new TextEncoder().encode(`quark-vault:${rootFid}`));
		const dataFid = await this.client.ensureFolder(rootFid, CLOUD_DATA_DIRECTORY);
		const blobsFid = await this.client.ensureFolder(dataFid, CLOUD_BLOB_DIRECTORY);
		const eventsFid = await this.client.ensureFolder(dataFid, CLOUD_EVENT_DIRECTORY);
		const deviceFid = await this.client.ensureFolder(eventsFid, this.state.deviceId);
		return { rootFid, vaultId, dataFid, blobsFid, eventsFid, deviceFid };
	}

	private async readAllEvents(layout: CloudLayout): Promise<VersionEvent[]> {
		if (!layout.eventsFid) return [];
		const deviceFolders = (await this.client.listDirectory(layout.eventsFid)).filter((item) => item.isDirectory);
		const events: VersionEvent[] = [];
		for (const deviceFolder of deviceFolders) {
			if (!/^[a-z0-9-]{1,80}$/i.test(deviceFolder.name)) throw new Error('夸克事件目录包含无效设备名，已暂停同步');
			for (const manifestFile of await this.client.listDirectory(deviceFolder.fid)) {
				if (manifestFile.isDirectory) throw new Error('夸克事件目录结构异常，已暂停同步');
				if (!MANIFEST_NAME.test(manifestFile.name)) throw new Error('夸克事件目录包含未知文件，已暂停同步');
				if (manifestFile.size > MAX_MANIFEST_BYTES) throw new Error('夸克清单超过 10 MiB，已暂停同步');
				const bytes = await this.client.downloadFile(manifestFile);
				const manifest = await parseBatchManifest(bytes, layout.vaultId, manifestFile.name);
				if (manifest.deviceId !== deviceFolder.name) throw new Error('清单设备与目录不匹配，已暂停同步');
				events.push(...manifest.events);
			}
		}
		return events;
	}

	private async ensureBlob(blobsFid: string, sha256: string, size: number, bytes: Uint8Array, onProgress?: (bytes: number) => void): Promise<void> {
		const name = `${sha256}.bin`;
		const existing = await this.client.findChildByName(blobsFid, name);
		if (existing) {
			if (existing.isDirectory || existing.size !== size) throw new Error(`夸克内容对象大小冲突：${name}`);
			const remoteBytes = await this.client.downloadFile(existing);
			if (await sha256Hex(remoteBytes) !== sha256) throw new Error(`夸克内容对象摘要错误：${name}`);
			return;
		}
		const uploaded = await this.client.uploadFile(blobsFid, name, bytes, onProgress);
		const confirmed = await this.client.downloadFile(uploaded);
		if (confirmed.byteLength !== size || await sha256Hex(confirmed) !== sha256) {
			throw new Error(`夸克内容对象上传校验失败：${name}`);
		}
	}

	private async publishBatch(layout: CloudLayout, events: VersionEvent[]): Promise<void> {
		if (events.length === 0) return;
		const manifest = await createBatchManifest(layout.vaultId, this.state.deviceId, events);
		const fileName = `${manifest.batchId}.json`;
		const existing = await this.client.findChildByName(layout.deviceFid!, fileName);
		if (existing) {
			if (existing.isDirectory || existing.size !== manifest.bytes.byteLength) throw new Error(`夸克清单同名冲突：${fileName}`);
			const current = await this.client.downloadFile(existing);
			await parseBatchManifest(current, layout.vaultId, fileName);
			if (!equalBytes(current, manifest.bytes)) throw new Error(`夸克清单内容冲突：${fileName}`);
			return;
		}
		const uploaded = await this.client.uploadFile(layout.deviceFid!, fileName, manifest.bytes);
		const confirmed = await this.client.downloadFile(uploaded);
		await parseBatchManifest(confirmed, layout.vaultId, fileName);
		if (!equalBytes(confirmed, manifest.bytes)) throw new Error(`夸克清单上传校验失败：${fileName}`);
	}

	private acknowledgeLocalEvents(events: VersionEvent[]): void {
		for (const event of events) {
			const branch = Object.create(null) as Record<string, SyncSnapshot>;
			branch[event.path] = {
				hash: event.kind === 'file' ? event.sha256 ?? null : null,
				heads: [event.id],
			};
			this.state.snapshots[event.path] = branch[event.path];
		}
	}

	private async applyPath(
		layout: CloudLayout,
		pathPlan: SyncPlan['paths'][number],
		progress?: (state: SyncProgress) => void,
	): Promise<'downloaded' | 'deleted' | 'unchanged' | 'skipped'> {
		await this.validateApplyPaths(pathPlan);
		this.state.pendingApplies[pathPlan.path] = {
			beforeHash: pathPlan.expectedLocalHash,
			desiredHash: pathPlan.nextSnapshot.hash,
			heads: [...pathPlan.nextSnapshot.heads],
		};
		await this.state.persist();

		for (const event of pathPlan.result.conflictCopies) {
			const copyPath = conflictPathFor(pathPlan.path, event);
			const existing = await this.local.read(copyPath);
			if (existing) {
				if (existing.sha256 !== event.sha256) throw new Error(`冲突副本路径已有不同内容：${copyPath}`);
				continue;
			}
			const local = await this.local.read(pathPlan.path);
			const bytes = local && local.sha256 === event.sha256 ? local.bytes : await this.downloadWithProgress(layout, event, progress);
			if (bytes.byteLength !== event.size || await sha256Hex(bytes) !== event.sha256) {
				throw new Error(`冲突版本校验失败：${copyPath}`);
			}
			await this.local.write(copyPath, bytes, this.app.vault.configDir, true);
		}

		const currentHash = await this.local.currentHash(pathPlan.path);
		if (currentHash !== pathPlan.expectedLocalHash) {
			await this.acknowledgeAndClearPending(pathPlan);
			return 'skipped';
		}

		if (pathPlan.result.deleted) {
			if (currentHash === null) {
				await this.acknowledgeAndClearPending(pathPlan);
				return 'unchanged';
			}
			let removed: boolean;
			try {
				removed = await applyIfCurrentHash(
					() => this.local.currentHash(pathPlan.path),
					pathPlan.expectedLocalHash,
					() => this.local.trash(pathPlan.path, this.app.vault.configDir, pathPlan.expectedLocalHash),
				);
			} catch (error) {
				if (await this.local.currentHash(pathPlan.path).catch(() => '__read-error__') !== pathPlan.expectedLocalHash) {
					await this.acknowledgeAndClearPending(pathPlan);
					return 'skipped';
				}
				throw error;
			}
			if (!removed) {
				await this.acknowledgeAndClearPending(pathPlan);
				return 'skipped';
			}
			await this.acknowledgeAndClearPending(pathPlan);
			return 'deleted';
		}

		const winner = pathPlan.result.winner;
		if (!winner || currentHash === winner.sha256) {
			await this.acknowledgeAndClearPending(pathPlan);
			return 'unchanged';
		}
		const bytes = await this.downloadWithProgress(layout, winner, progress);
		let written: boolean;
		try {
			written = await applyIfCurrentHash(
				() => this.local.currentHash(pathPlan.path),
				pathPlan.expectedLocalHash,
				() => this.local.write(pathPlan.path, bytes, this.app.vault.configDir, false, pathPlan.expectedLocalHash),
			);
		} catch (error) {
			if (await this.local.currentHash(pathPlan.path).catch(() => '__read-error__') !== pathPlan.expectedLocalHash) {
				await this.acknowledgeAndClearPending(pathPlan);
				return 'skipped';
			}
			throw error;
		}
		await this.acknowledgeAndClearPending(pathPlan);
		return written ? 'downloaded' : 'skipped';
	}

	private async downloadWithProgress(layout: CloudLayout, event: VersionEvent, progress?: (state: SyncProgress) => void): Promise<Uint8Array> {
		const report = (bytes: number) => progress?.({ path: event.path, phase: 'download', bytes, total: event.size });
		report(0);
		return await this.downloadBlob(layout, event, report);
	}

	private async downloadBlob(layout: CloudLayout, event: VersionEvent, onProgress?: (bytes: number) => void): Promise<Uint8Array> {
		if (!event.sha256 || event.size === undefined || !layout.blobsFid) throw new Error('版本记录缺少内容摘要或大小');
		const name = `${event.sha256}.bin`;
		const blob = await this.client.findChildByName(layout.blobsFid, name);
		if (!blob || blob.isDirectory || blob.size !== event.size) throw new Error(`夸克中缺少内容对象：${name}`);
		const bytes = await this.client.downloadFile(blob, undefined, onProgress);
		if (bytes.byteLength !== event.size || await sha256Hex(bytes) !== event.sha256) throw new Error(`夸克内容校验失败：${name}`);
		return bytes;
	}

	private async validateApplyPaths(pathPlan: SyncPlan['paths'][number]): Promise<void> {
		const localPaths = this.local.listPaths(this.app.vault.configDir);
		const mainTargets = pathPlan.result.deleted || !pathPlan.result.winner ? [] : [pathPlan.path];
		const ordinaryPaths = [...new Set([...localPaths, ...mainTargets])];
		validatePathSet(ordinaryPaths, this.app.vault.configDir);

		if (pathPlan.result.conflictCopies.length > 0) {
			const existingConflictPaths = await this.local.listConflictRelativePaths();
			const newConflictPaths = pathPlan.result.conflictCopies.map((event) =>
				conflictPathFor(pathPlan.path, event).slice(CONFLICT_DIRECTORY.length + 1),
			);
			validatePathSet([...new Set([...existingConflictPaths, ...newConflictPaths])], this.app.vault.configDir);
			await this.local.hasConflictDirectory();
		}
	}

	private async acknowledgeAndClearPending(pathPlan: SyncPlan['paths'][number]): Promise<void> {
		this.state.snapshots[pathPlan.path] = {
			hash: pathPlan.nextSnapshot.hash,
			heads: [...pathPlan.nextSnapshot.heads],
		};
		delete this.state.pendingApplies[pathPlan.path];
		await this.state.persist();
	}

	private async recoverPendingApplies(excluded: ReadonlySet<string>, selectedPath?: string): Promise<void> {
		let changed = false;
		for (const [path, pending] of Object.entries(this.state.pendingApplies)) {
			if (excluded.has(path) || (selectedPath !== undefined && path !== selectedPath)) continue;
			if ([...this.managedPaths()].some((managedPath) => pathKey(managedPath) === pathKey(path))) {
				delete this.state.pendingApplies[path];
				changed = true;
				continue;
			}
			const currentHash = await this.local.currentHash(path).catch(() => '__read-error__');
			const recovery = recoverPendingApply(currentHash, pending);
			if (recovery === 'finish') {
				this.state.snapshots[path] = { hash: pending.desiredHash, heads: [...pending.heads] };
			}
			delete this.state.pendingApplies[path];
			changed = true;
		}
		if (changed) await this.state.persist();
	}
}

function pathKey(path: string): string {
	return path.replace(/\\/g, '/').normalize('NFKC').toLowerCase();
}

function conflictPathFor(path: string, event: VersionEvent): string {
	const segments = path.split('/');
	const filename = segments.pop()!;
	const extIndex = filename.lastIndexOf('.');
	const stem = extIndex > 0 ? filename.slice(0, extIndex) : filename;
	const extension = extIndex > 0 ? filename.slice(extIndex) : '';
	const targetName = `${stem}.${event.deviceId}.${event.id.slice(0, 12)}${extension}`;
	return `${CONFLICT_DIRECTORY}/${[...segments, targetName].filter(Boolean).join('/')}`;
}

function splitEvents(events: VersionEvent[], maxBytes: number): VersionEvent[][] {
	const batches: VersionEvent[][] = [];
	let current: VersionEvent[] = [];
	for (const event of events) {
		const proposed = [...current, event];
		const size = new TextEncoder().encode(JSON.stringify({ schema: 1, events: proposed })).byteLength;
		if (size > maxBytes && current.length > 0) {
			batches.push(current);
			current = [event];
		} else {
			current = proposed;
		}
		if (new TextEncoder().encode(JSON.stringify({ schema: 1, events: current })).byteLength > MAX_MANIFEST_BYTES) {
			throw new Error(`单条版本记录超过清单大小上限：${event.path}`);
		}
	}
	if (current.length > 0) batches.push(current);
	return batches;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
	return true;
}

function dedupeSkipped(skipped: SyncSummary['skipped']): SyncSummary['skipped'] {
	const keys = new Set<string>();
	return skipped.filter((entry) => {
		const key = `${entry.path}\u0000${entry.reason}`;
		if (keys.has(key)) return false;
		keys.add(key);
		return true;
	});
}

function safeError(error: unknown): string {
	return error instanceof Error ? error.message : '同步失败，已跳过此路径';
}
