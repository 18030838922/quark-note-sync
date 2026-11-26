import { hasAsciiControl } from './core.ts';

export interface UploadCheckpoint {
	version: 1;
	key: string;
	taskId: string;
	authInfo: string;
	objectKey: string;
	bucket: string;
	uploadId: string;
	uploadHost: string;
	partSize: number;
	callback: string;
	fileId?: string;
	etags: string[];
	committed: boolean;
}

/** Store upload authorization in device-local secret storage. The key is an opaque fingerprint. */
export interface UploadCheckpointStore {
	get(key: string): unknown | Promise<unknown>;
	set(key: string, value: UploadCheckpoint | null): void | Promise<void>;
}

export function readUploadCheckpoint(value: unknown, key: string, size: number): UploadCheckpoint | undefined {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (record.version !== 1 || record.key !== key || typeof record.committed !== 'boolean') return undefined;
	const { taskId, authInfo, objectKey, bucket, uploadId, uploadHost, partSize, callback, fileId, etags } = record;
	if (!isUploadField(taskId) || !isUploadField(authInfo) || !isUploadField(objectKey) || !isUploadField(bucket)
		|| !isUploadField(uploadId) || !isUploadField(uploadHost) || typeof callback !== 'string'
		|| (fileId !== undefined && !isUploadField(fileId))) return undefined;
	if (typeof partSize !== 'number' || !Number.isSafeInteger(partSize) || partSize < 1) return undefined;
	const totalParts = Math.ceil(size / partSize);
	if (totalParts < 2 || !Array.isArray(etags) || etags.length > totalParts
		|| (record.committed && etags.length !== totalParts)) return undefined;
	const validatedEtags: string[] = [];
	for (const etag of etags) {
		if (typeof etag !== 'string' || !/^[a-f\d]{1,128}$/i.test(etag)) return undefined;
		validatedEtags.push(etag);
	}
	return {
		version: 1, key, taskId, authInfo, objectKey, bucket, uploadId, uploadHost,
		partSize, callback, fileId, etags: validatedEtags, committed: record.committed,
	};
}

function isUploadField(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && !hasAsciiControl(value);
}
