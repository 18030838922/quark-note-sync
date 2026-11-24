import { MAX_FILE_BYTES, validateVaultPath, type VersionEvent } from './core.ts';
import { sha256Hex } from './hash.ts';

export interface BatchManifest {
	schema: 1;
	vaultId: string;
	deviceId: string;
	events: VersionEvent[];
	batchId: string;
}

export interface CreatedBatchManifest {
	batchId: string;
	bytes: Uint8Array;
}

export async function createBatchManifest(
	vaultId: string,
	deviceId: string,
	events: VersionEvent[],
): Promise<CreatedBatchManifest> {
	if (!vaultId || !deviceId || events.length === 0) throw new Error('清单缺少库、设备或版本记录');
	const normalizedEvents: VersionEvent[] = [];
	for (const event of [...events].sort((a, b) => compareId(a.path, b.path) || compareId(a.id, b.id))) {
		await validateEvent(event, deviceId);
		normalizedEvents.push({ ...event, parents: [...event.parents].sort(compareId) });
	}
	const payload = { schema: 1 as const, vaultId, deviceId, events: normalizedEvents };
	const batchId = await sha256Hex(new TextEncoder().encode(JSON.stringify(payload)));
	const manifest: BatchManifest = { ...payload, batchId };
	return { batchId, bytes: new TextEncoder().encode(JSON.stringify(manifest)) };
}

export async function parseBatchManifest(
	bytes: Uint8Array,
	expectedVaultId: string,
	expectedFileName: string,
): Promise<BatchManifest> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new Error('清单校验失败：JSON 无法解析');
	}
	const record = asRecord(parsed);
	if (record.schema !== 1 || typeof record.vaultId !== 'string' || typeof record.deviceId !== 'string' || !Array.isArray(record.events)) {
		throw new Error('清单校验失败：格式不受支持');
	}
	if (record.vaultId !== expectedVaultId) throw new Error('清单库不匹配，已暂停同步');
	if (typeof record.batchId !== 'string' || !/^[a-f\d]{64}$/i.test(record.batchId) || expectedFileName !== `${record.batchId}.json`) {
		throw new Error('清单文件名与内容不匹配');
	}
	const events: VersionEvent[] = [];
	for (const value of record.events) {
		const event = value as VersionEvent;
		await validateEvent(event, record.deviceId);
		events.push({ ...event, parents: [...event.parents].sort(compareId) });
	}
	const payload = { schema: 1 as const, vaultId: record.vaultId, deviceId: record.deviceId, events };
	const actualBatchId = await sha256Hex(new TextEncoder().encode(JSON.stringify(payload)));
	if (actualBatchId !== record.batchId) throw new Error('清单校验失败：内容摘要不匹配');
	return { ...payload, batchId: record.batchId };
}

async function validateEvent(event: VersionEvent, manifestDeviceId: string): Promise<void> {
	if (!event || typeof event !== 'object' || typeof event.id !== 'string' || !/^[a-f\d]{64}$/i.test(event.id)) {
		throw new Error('清单校验失败：版本编号无效');
	}
	if (typeof event.path !== 'string' || typeof event.deviceId !== 'string' || event.deviceId !== manifestDeviceId) {
		throw new Error('清单校验失败：设备或路径无效');
	}
	validateVaultPath(event.path);
	if (!Array.isArray(event.parents) || event.parents.some((parent) => typeof parent !== 'string' || !/^[a-f\d]{64}$/i.test(parent))) {
		throw new Error('清单校验失败：父版本编号无效');
	}
	if (new Set(event.parents).size !== event.parents.length) throw new Error('清单校验失败：父版本重复');
	if (!Number.isSafeInteger(event.createdAt) || event.createdAt < 0) throw new Error('清单校验失败：时间无效');
	if (event.kind === 'file') {
		if (typeof event.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(event.sha256)) throw new Error('清单校验失败：文件摘要无效');
		if (!Number.isSafeInteger(event.size) || (event.size ?? MAX_FILE_BYTES + 1) < 0 || (event.size ?? MAX_FILE_BYTES + 1) > MAX_FILE_BYTES) {
			throw new Error('清单校验失败：文件超过大小上限');
		}
	} else if (event.kind === 'delete') {
		if (event.sha256 !== undefined || event.size !== undefined) throw new Error('清单校验失败：删除版本包含文件内容');
	} else {
		throw new Error('清单校验失败：版本类型无效');
	}
	const payload = {
		path: event.path,
		kind: event.kind,
		parents: [...event.parents].sort(compareId),
		...(event.kind === 'file' ? { sha256: event.sha256, size: event.size } : {}),
		deviceId: event.deviceId,
		createdAt: event.createdAt,
	};
	if (await sha256Hex(new TextEncoder().encode(JSON.stringify(payload))) !== event.id) {
		throw new Error('清单校验失败：版本编号与内容不匹配');
	}
}

function asRecord(input: unknown): Record<string, unknown> {
	return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

function compareId(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
