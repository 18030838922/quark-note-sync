import { isSyncablePath, resolvePathEvents, validatePathSet, type ResolvedPath, type VersionEvent } from './core.ts';
import { sha256Hex } from './hash.ts';

export interface SyncSnapshot {
	hash: string | null;
	heads: string[];
}

export interface LocalFileState {
	path: string;
	sha256: string;
	size: number;
}

export interface PlanInput {
	localFiles: LocalFileState[];
	presentPaths: string[];
	protectedPaths?: Map<string, string>;
	snapshots: Record<string, SyncSnapshot>;
	remoteEvents: VersionEvent[];
	managedPaths?: readonly string[];
	deferredAttachments?: ReadonlySet<string>;
	deviceId: string;
	now: number;
	configDir: string;
}

export interface PlannedPath {
	path: string;
	result: ResolvedPath;
	expectedLocalHash: string | null;
	localPresent: boolean;
	deferred?: boolean;
	localEvents: VersionEvent[];
	nextSnapshot: SyncSnapshot;
}

export interface SyncPlan {
	events: VersionEvent[];
	paths: PlannedPath[];
	skipped: Array<{ path: string; reason: string }>;
	nextSnapshots: Record<string, SyncSnapshot>;
}

export async function buildSyncPlan(input: PlanInput): Promise<SyncPlan> {
	const { configDir } = input;
	const managedPathKeys = new Set((input.managedPaths ?? []).map(pathKey));
	const skipped: Array<{ path: string; reason: string }> = [];
	const skippedPaths = new Set<string>();
	const addSkipped = (path: string, reason: string) => {
		if (!skippedPaths.has(path)) {
			skippedPaths.add(path);
			skipped.push({ path, reason });
		}
	};
	const localByPath = new Map<string, LocalFileState>();
	for (const file of input.localFiles) {
		if (managedPathKeys.has(pathKey(file.path))) continue;
		if (localByPath.has(file.path)) {
			addSkipped(file.path, '本地出现重复路径');
			continue;
		}
		localByPath.set(file.path, file);
	}
	const remoteByPath = new Map<string, VersionEvent[]>();
	for (const event of input.remoteEvents) {
		if (managedPathKeys.has(pathKey(event.path))) continue;
		const list = remoteByPath.get(event.path) ?? [];
		list.push(event);
		remoteByPath.set(event.path, list);
	}

	const candidatePaths = new Set<string>([
		...input.presentPaths.filter((path) => !managedPathKeys.has(pathKey(path))),
		...input.localFiles.map((file) => file.path).filter((path) => !managedPathKeys.has(pathKey(path))),
		...Object.keys(input.snapshots).filter((path) => !managedPathKeys.has(pathKey(path))),
		...remoteByPath.keys(),
	]);
	const validPaths: string[] = [];
	for (const path of candidatePaths) {
		try {
			validatePathSet([path], configDir);
			validPaths.push(path);
		} catch (error) {
			addSkipped(path, error instanceof Error ? error.message : '同步路径无效');
		}
	}
	try {
		validatePathSet(validPaths, configDir);
	} catch (error) {
		const reason = `路径冲突，已暂停本轮合并：${error instanceof Error ? error.message : '无法安全映射到此设备'}`;
		for (const path of validPaths) addSkipped(path, reason);
		return { events: [], paths: [], skipped, nextSnapshots: copySnapshots(input.snapshots, managedPathKeys) };
	}

	const protectedPaths = input.protectedPaths ?? new Map<string, string>();
	const allEvents: VersionEvent[] = [];
	const paths: PlannedPath[] = [];
	const nextSnapshots = copySnapshots(input.snapshots, managedPathKeys);
	for (const path of validPaths) {
		const protectedReason = protectedPaths.get(path);
		if (protectedReason) {
			addSkipped(path, protectedReason);
			continue;
		}
		const local = localByPath.get(path);
		if (local && !isSyncablePath(path, local.size, configDir)) {
			addSkipped(path, '文件路径或大小不符合同步规则');
			continue;
		}
		const remoteHistory = remoteByPath.get(path) ?? [];
		const previous = hasOwn(input.snapshots, path) ? input.snapshots[path] : undefined;
		if (previous && remoteHistory.length > 0) {
			const remoteIds = new Set(remoteHistory.map((event) => event.id));
			if (previous.heads.some((head) => !remoteIds.has(head))) {
				addSkipped(path, '夸克历史缺少已确认的版本，已暂停变更');
				continue;
			}
		}
		let remoteState: ResolvedPath | undefined;
		if (remoteHistory.length > 0) {
			try {
				remoteState = resolvePathEvents(remoteHistory);
			} catch (error) {
				addSkipped(path, error instanceof Error ? error.message : '夸克历史不完整');
				continue;
			}
		} else if (previous) {
			addSkipped(path, '夸克历史缺少此路径的已确认版本，已暂停变更');
			continue;
		}

		const localHash = local?.sha256 ?? null;
		let shouldRecord = false;
		if (!previous) {
			if (local && remoteState?.winner?.sha256 !== local.sha256) shouldRecord = true;
		} else if (localHash !== previous.hash && (local || !input.deferredAttachments?.has(path))) {
			const alreadyRepresented = remoteState?.heads.some((event) =>
				local ? event.kind === 'file' && event.sha256 === local.sha256 : event.kind === 'delete',
			) ?? false;
			if (!alreadyRepresented) shouldRecord = true;
		}

		const localEvents: VersionEvent[] = [];
		if (shouldRecord) {
			const kind = local ? 'file' : 'delete';
			const parents = previous ? [...previous.heads].sort(compareId) : [];
			const eventBody: Omit<VersionEvent, 'id'> = {
				path,
				kind,
				parents,
				...(local ? { sha256: local.sha256, size: local.size } : {}),
				deviceId: input.deviceId,
				createdAt: input.now,
			};
			const id = await sha256Hex(new TextEncoder().encode(JSON.stringify(eventBody)));
			localEvents.push({ id, ...eventBody });
			allEvents.push(...localEvents);
		}

		const combinedHistory = [...remoteHistory, ...localEvents];
		if (combinedHistory.length === 0) continue;
		let result: ResolvedPath;
		try {
			result = resolvePathEvents(combinedHistory);
		} catch (error) {
			addSkipped(path, error instanceof Error ? error.message : '合并历史不完整');
			allEvents.splice(allEvents.length - localEvents.length, localEvents.length);
			continue;
		}
		const nextSnapshot = {
			hash: result.winner?.sha256 ?? null,
			heads: result.heads.map((event) => event.id).sort(compareId),
		};
		nextSnapshots[path] = nextSnapshot;
		paths.push({
			path,
			result,
			expectedLocalHash: localHash,
			localPresent: local !== undefined,
			localEvents,
			nextSnapshot,
		});
	}
	return { events: allEvents, paths, skipped, nextSnapshots };
}

function copySnapshots(input: Record<string, SyncSnapshot>, excludedPathKeys = new Set<string>()): Record<string, SyncSnapshot> {
	const output = Object.create(null) as Record<string, SyncSnapshot>;
	for (const [path, snapshot] of Object.entries(input)) {
		if (excludedPathKeys.has(pathKey(path))) continue;
		output[path] = { hash: snapshot.hash, heads: [...snapshot.heads] };
	}
	return output;
}

function pathKey(path: string): string {
	return path.replace(/\\/g, '/').normalize('NFKC').toLowerCase();
}

function hasOwn(input: object, key: PropertyKey): boolean {
	return Object.prototype.hasOwnProperty.call(input, key);
}

function compareId(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
