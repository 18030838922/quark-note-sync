import assert from 'node:assert/strict';
import test from 'node:test';
import { QuarkClient } from '../src/quark-api.ts';
import type { HttpRequest, HttpResponse } from '../src/transport.ts';

const contents = Uint8Array.of(1, 2, 3, 4, 5);

function fixture() {
	const persisted = new Map<string, unknown>();
	const store = {
		get: (key: string): unknown => structuredClone(persisted.get(key)),
		set: (key: string, value: unknown): void => {
			if (value === null) persisted.delete(key);
			else persisted.set(key, structuredClone(value));
		},
	};
	const parts: string[] = [];
	const commits: string[] = [];
	const controls = {
		visible: false, failPart: true, expireUpload: false, expireAuthorization: false, failFinish: false,
	};
	let tasks = 0;
	function response(body: unknown, status = 200, headers: Record<string, string> = {}): HttpResponse {
		const text = typeof body === 'string' ? body : JSON.stringify(body);
		return { status, url: '', headers, data: new TextEncoder().encode(text), text: () => text };
	}
	function client(cookie = 'sid=fixture-a'): QuarkClient {
		return new QuarkClient({
			request: async (request: HttpRequest): Promise<HttpResponse> => {
				const url = new URL(request.url);
				if (request.purpose === 'upload') {
					const upload = url.searchParams.get('uploadId');
					if (request.method === 'PUT') {
						const part = url.searchParams.get('partNumber');
						parts.push(`${upload}/${part}`);
						if (part === '2' && controls.failPart) {
							controls.failPart = false;
							return response('', 503);
						}
						if (upload === 'upload-1' && controls.expireUpload) {
							return response('<Error><Code>NoSuchUpload</Code></Error>', 404);
						}
						return response('', 200, { etag: `"ab${part}"` });
					}
					commits.push(new TextDecoder().decode(request.body as Uint8Array));
					return response('');
				}
				if (url.pathname.endsWith('/account/info')) {
					return response({ code: 0, data: { id: request.cookie === 'sid=fixture-b' ? 'account-b' : 'account-a' } });
				}
				if (url.pathname.endsWith('/file/sort')) {
					return response({ code: 0, data: {
						list: controls.visible ? [{ fid: 'file-fid', file_name: 'known.bin', file_type: 1, size: 5 }] : [],
						metadata: { _total: controls.visible ? 1 : 0 },
					} });
				}
				if (url.pathname.endsWith('/file/upload/pre')) {
					tasks += 1;
					return response({ code: 0, data: {
						task_id: `task-${tasks}`, auth_info: `fixture-auth-${tasks}`, upload_id: `upload-${tasks}`,
						obj_key: 'object', bucket: 'bucket', upload_url: 'pds.quark.cn', part_size: 2,
					} });
				}
				if (url.pathname.endsWith('/file/update/hash')) return response({ code: 0, data: {} });
				if (url.pathname.endsWith('/file/upload/auth')) {
					if (controls.expireAuthorization && JSON.parse(String(request.body)).task_id === 'task-1') {
						return response({ code: 'UploadTaskExpired' });
					}
					return response({ code: 0, data: { auth_key: 'fixture-auth-key' } });
				}
				if (url.pathname.endsWith('/file/upload/finish')) {
					if (controls.failFinish) {
						controls.failFinish = false;
						return response({ code: 0 }, 503);
					}
					controls.visible = true;
					return response({ code: 0, data: {} });
				}
				throw new Error(`Unexpected fixture request: ${url.pathname}`);
			},
		}, cookie, store);
	}
	return { client, parts, commits, controls, persisted };
}

test('a new sync client resumes persisted completed parts and delegates the remaining pieces', async () => {
	const { client, parts, commits, persisted } = fixture();
	await assert.rejects(() => client().uploadFile('folder', 'known.bin', contents), /503/);
	assert.deepEqual(parts, ['upload-1/1', 'upload-1/2']);
	assert.equal(persisted.size, 1);

	const progress: number[] = [];
	const uploaded = await client().uploadFile('folder', 'known.bin', contents, (bytes) => progress.push(bytes));
	assert.equal(uploaded.fid, 'file-fid');
	assert.deepEqual(parts, ['upload-1/1', 'upload-1/2', 'upload-1/2', 'upload-1/3']);
	assert.deepEqual(progress, [2, 4, 5]);
	assert.deepEqual([...commits[0].matchAll(/<PartNumber>(\d+)<\/PartNumber><ETag>"([^"]+)"/g)].map((entry) => entry.slice(1)), [
		['1', 'ab1'], ['2', 'ab2'], ['3', 'ab3'],
	]);
	assert.equal(persisted.size, 0);
});

test('a server-expired multipart upload starts a new upload once', async () => {
	const { client, controls, parts } = fixture();
	await assert.rejects(() => client().uploadFile('folder', 'known.bin', contents), /503/);
	controls.expireUpload = true;
	await client().uploadFile('folder', 'known.bin', contents);
	assert.deepEqual(parts, ['upload-1/1', 'upload-1/2', 'upload-1/2', 'upload-2/1', 'upload-2/2', 'upload-2/3']);
});

test('a server-expired authorization task starts a new upload once', async () => {
	const { client, controls, parts } = fixture();
	await assert.rejects(() => client().uploadFile('folder', 'known.bin', contents), /503/);
	controls.expireAuthorization = true;
	await client().uploadFile('folder', 'known.bin', contents);
	assert.deepEqual(parts, ['upload-1/1', 'upload-1/2', 'upload-2/1', 'upload-2/2', 'upload-2/3']);
});

test('a transient finish failure only retries Quark finish after object storage has committed', async () => {
	const { client, controls, parts, commits, persisted } = fixture();
	controls.failPart = false;
	controls.failFinish = true;
	await assert.rejects(() => client().uploadFile('folder', 'known.bin', contents), /503/);
	await client().uploadFile('folder', 'known.bin', contents);
	assert.deepEqual(parts, ['upload-1/1', 'upload-1/2', 'upload-1/3']);
	assert.equal(commits.length, 1);
	assert.equal(persisted.size, 0);
});

test('a checkpoint cannot supply completed parts for another account, destination, or same-length content', async () => {
	for (const [cookie, folder, bytes] of [
		['sid=fixture-b', 'folder', contents],
		['sid=fixture-a', 'new-folder', contents],
		['sid=fixture-a', 'folder', Uint8Array.of(1, 2, 3, 4, 6)],
	] as const) {
		const { client, parts } = fixture();
		await assert.rejects(() => client().uploadFile('folder', 'known.bin', contents), /503/);
		await client(cookie).uploadFile(folder, 'known.bin', bytes);
		assert.deepEqual(parts.slice(2), ['upload-2/1', 'upload-2/2', 'upload-2/3']);
	}
});

test('concurrent retries of the same content share a single multipart task', async () => {
	const { client, controls, parts, commits } = fixture();
	controls.failPart = false;
	const [first, second] = await Promise.all([
		client().uploadFile('folder', 'known.bin', contents),
		client().uploadFile('folder', 'known.bin', contents),
	]);
	assert.equal(first.fid, second.fid);
	assert.deepEqual(parts, ['upload-1/1', 'upload-1/2', 'upload-1/3']);
	assert.equal(commits.length, 1);
});

test('a corrupted local upload endpoint is ignored', async () => {
	const { client, parts, persisted } = fixture();
	await assert.rejects(() => client().uploadFile('folder', 'known.bin', contents), /503/);
	for (const [key, value] of persisted) {
		persisted.set(key, { ...(value as object), uploadHost: 'https://other.invalid' });
	}
	await client().uploadFile('folder', 'known.bin', contents);
	assert.deepEqual(parts.slice(2), ['upload-2/1', 'upload-2/2', 'upload-2/3']);
});
