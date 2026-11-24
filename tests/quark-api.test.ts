import assert from 'node:assert/strict';
import test from 'node:test';
import type { HttpRequest, HttpResponse } from '../src/transport.ts';
import { QuarkTransportError } from '../src/transport.ts';
import { QuarkAuthenticationError, QuarkClient } from '../src/quark-api.ts';

class FixtureTransport {
	requests: HttpRequest[] = [];
	private readonly responder: (request: HttpRequest, index: number) => HttpResponse;
	constructor(responder: (request: HttpRequest, index: number) => HttpResponse) { this.responder = responder; }
	async request(request: HttpRequest): Promise<HttpResponse> {
		this.requests.push(request);
		return this.responder(request, this.requests.length - 1);
	}
}

const response = (body: unknown, status = 200): HttpResponse => {
	const text = JSON.stringify(body);
	const data = new TextEncoder().encode(text);
	return { status, headers: { 'content-type': 'application/json' }, url: '', data, text: () => text };
};

test('storage quota reads the declared byte counters from the read-only member endpoint', async () => {
	const transport = new FixtureTransport(() => response({ code: 0, data: { total_capacity: 1000, use_capacity: 375 } }));
	const quota = await new QuarkClient(transport, 'sid=secret').getStorageQuota();

	assert.deepEqual(quota, { totalBytes: 1000, usedBytes: 375 });
	assert.equal(transport.requests.length, 1);
	const request = transport.requests[0];
	const url = new URL(request.url);
	assert.equal(request.method, 'GET');
	assert.equal(url.origin, 'https://drive-pc.quark.cn');
	assert.equal(url.pathname, '/1/clouddrive/member');
	assert.equal(url.searchParams.get('pr'), 'ucpro');
	assert.equal(url.searchParams.get('fr'), 'pc');
	assert.equal(request.cookie, 'sid=secret');
});

test('storage quota is unavailable when the endpoint fails or returns invalid byte counters', async () => {
	const failed = new FixtureTransport(() => { throw new Error('endpoint unavailable'); });
	assert.equal(await new QuarkClient(failed, 'sid=secret').getStorageQuota(), undefined);

	for (const data of [
		{},
		{ total_capacity: 'unknown', use_capacity: 0 },
		{ total_capacity: -1, use_capacity: 0 },
		{ total_capacity: 100, use_capacity: 101 },
	]) {
		const transport = new FixtureTransport(() => response({ code: 0, data }));
		assert.equal(await new QuarkClient(transport, 'sid=secret').getStorageQuota(), undefined);
	}
});

test('directory listing follows all declared pages before returning files', async () => {
	const transport = new FixtureTransport((_request, index) => {
		const start = index * 50;
		const list = Array.from({ length: index === 0 ? 50 : 2 }, (_, offset) => ({
			fid: `fid-${start + offset}`,
			file_name: `file-${start + offset}.md`,
			file_type: 1,
			dir: false,
			size: 10,
		}));
		return response({ code: 0, data: { list }, metadata: { _total: 52 } });
	});
	const client = new QuarkClient(transport, 'sid=secret');
	const result = await client.listDirectory('parent');

	assert.equal(result.length, 52);
	assert.equal(transport.requests.length, 2);
	assert.equal(new URL(transport.requests[0].url).searchParams.get('_page'), '1');
	assert.equal(new URL(transport.requests[1].url).searchParams.get('_page'), '2');
});

test('missing or short pagination metadata stops the listing as incomplete', async () => {
	const missingTotal = new FixtureTransport(() => response({ code: 0, data: { list: [] } }));
	await assert.rejects(() => new QuarkClient(missingTotal, 'sid=x').listDirectory('parent'), /分页/);

	const shortPage = new FixtureTransport((_request, index) => response({
		code: 0,
		data: { list: index === 0 ? Array.from({ length: 50 }, (_, i) => ({ fid: `f${i}`, file_name: `f${i}`, file_type: 1 })) : [], metadata: { _total: 51 } },
	}));
	await assert.rejects(() => new QuarkClient(shortPage, 'sid=x').listDirectory('parent'), /分页/);
});

test('invalid Cookie diagnostics never include the supplied Cookie value', async () => {
	const transport = new FixtureTransport(() => response({ code: 401, message: 'Unauthorized' }, 401));
	await assert.rejects(
		() => new QuarkClient(transport, 'secret-cookie-value').checkConnection(),
		(error: Error) => error.message.includes('Cookie') && !error.message.includes('secret-cookie-value'),
	);
	const semanticFailure = new FixtureTransport(() => response({ status: 401, message: 'Please log in', data: null }));
	await assert.rejects(
		() => new QuarkClient(semanticFailure, 'another-secret-cookie').checkConnection(),
		(error: Error) => error.message.includes('Cookie') && !error.message.includes('another-secret-cookie'),
	);
});

test('mobile transport upgrade diagnostics survive the API wrapper', async () => {
	const unavailable = {
		async request(_request: HttpRequest): Promise<HttpResponse> {
			throw new QuarkTransportError('当前 Obsidian 移动端未提供可关闭重定向的 HTTPS 接口，请升级 Obsidian 后重试');
		},
	};
	await assert.rejects(
		() => new QuarkClient(unavailable, 'sid=secret').checkConnection(),
		(error: Error) => error.message.includes('升级 Obsidian') && !error.message.includes('sid=secret'),
	);
});

test('connection check verifies read access to Quark Drive without modifying the account', async () => {
	const transport = new FixtureTransport((request) => {
		const url = new URL(request.url);
		if (url.hostname === 'pan.quark.cn') return response({ code: 0, data: { nickname: 'tester' } });
		return response({ code: 0, data: { list: [] }, metadata: { _total: 0 } });
	});
	await new QuarkClient(transport, 'sid=secret').checkConnection();
	assert.equal(transport.requests.length, 2);
	assert.ok(transport.requests.every((request) => request.method === 'GET'));
	assert.ok(transport.requests.some((request) => new URL(request.url).pathname.endsWith('/file/sort')));
});

test('account check returns a safe nickname from the existing account-info response', async () => {
	const transport = new FixtureTransport((request) => {
		const url = new URL(request.url);
		if (url.hostname === 'pan.quark.cn') return response({ code: 0, data: { nickname: '  tester  ', uid: 'account-123' } });
		return response({ code: 0, data: { list: [] }, metadata: { _total: 0 } });
	});

	assert.deepEqual(await new QuarkClient(transport, 'sid=secret').checkAccount(), {
		accountId: 'account-123',
		nickname: 'tester',
	});
	assert.equal(transport.requests.length, 2);
});

test('account check omits unsafe, non-string, or overlong nicknames', async () => {
	for (const nickname of [123, '', `x${'a'.repeat(128)}`, 'unsafe\nname']) {
		const transport = new FixtureTransport((request) => {
			const url = new URL(request.url);
			if (url.hostname === 'pan.quark.cn') return response({ code: 0, data: { nickname } });
			return response({ code: 0, data: { list: [] }, metadata: { _total: 0 } });
		});
		assert.deepEqual(await new QuarkClient(transport, 'sid=secret').checkAccount(), {});
	}
});

test('HTTP and API-envelope authentication failures use the typed auth error', async () => {
	for (const [status, body, httpStatus] of [
		[401, { code: 0 }, 401],
		[403, { code: 0 }, 403],
		[401, { status: 401 }, 200],
		[403, { code: 403 }, 200],
	] as const) {
		const transport = new FixtureTransport(() => response(body, httpStatus));
		await assert.rejects(
			() => new QuarkClient(transport, 'secret-cookie-value').checkConnection(),
			(error: Error) => {
				assert.ok(error instanceof QuarkAuthenticationError);
				assert.ok(error.message.includes('Cookie'));
				assert.equal(error.message.includes('secret-cookie-value'), false);
				assert.equal(error.status, status);
				return true;
			},
		);
	}
});

test('current Pan account-info code OK is accepted and only Quark auth cookies are refreshed', async () => {
	const transport = new FixtureTransport((request) => {
		const url = new URL(request.url);
		if (url.hostname === 'pan.quark.cn') {
			return {
				...response({ code: 'OK', success: true }),
				headers: { 'set-cookie': '__puus=refreshed; Path=/; HttpOnly\ntracking=drop-me; Path=/' },
			};
		}
		return response({ code: 0, data: { list: [] }, metadata: { _total: 0 } });
	});
	const client = new QuarkClient(transport, '__pus=primary; __uid=12345');
	assert.equal(await client.checkConnection(), '12345');
	assert.ok(transport.requests[1].cookie?.includes('__puus=refreshed'));
	assert.equal(client.sessionCookie.includes('tracking'), false);
});

test('Pan account-info negative semantic status is rejected even when code is OK', async () => {
	const transport = new FixtureTransport(() => response({ status: -1, code: 'OK', success: true }));
	await assert.rejects(() => new QuarkClient(transport, '__pus=primary').checkConnection(), /错误状态 -1/);
	assert.equal(transport.requests.length, 1);
});

test('upload normalizes approved host hints to HTTPS and sends signed bytes without the Quark Cookie', async () => {
	let uploaded = false;
	let uploadUrl = 'http://pds.quark.cn';
	const transport = new FixtureTransport((request) => {
		const url = new URL(request.url);
		if (request.purpose === 'upload') {
			return { status: request.method === 'PUT' ? 200 : 200, headers: { etag: 'a1b2c3' }, url: request.url, data: new Uint8Array(), text: () => '' };
		}
		if (url.pathname.endsWith('/file/sort')) {
			return response({ code: 0, data: { list: uploaded ? [{ fid: 'blob-fid', file_name: 'blob.bin', file_type: 1, size: 2 }] : [], metadata: { _total: uploaded ? 1 : 0 } } });
		}
		if (url.pathname.endsWith('/file/upload/pre')) {
			return response({ code: 0, data: { task_id: 'task', auth_info: 'auth', upload_id: 'upload', obj_key: 'object', bucket: 'bucket', upload_url: uploadUrl, callback: {} }, metadata: { part_size: 1 } });
		}
		if (url.pathname.endsWith('/file/update/hash')) return response({ code: 0, data: { finish: false } });
		if (url.pathname.endsWith('/file/upload/auth')) return response({ code: 0, data: { auth_key: 'one-time-signature' } });
		if (url.pathname.endsWith('/file/upload/finish')) {
			uploaded = true;
			return response({ code: 0, data: { finish: true } });
		}
		throw new Error(`Unexpected fixture request: ${url.pathname}`);
	});

	const client = new QuarkClient(transport, 'sid=secret');
	const file = await client.uploadFile('blob-folder', 'blob.bin', new Uint8Array([1, 2]));
	assert.equal(file.fid, 'blob-fid');
	assert.ok(transport.requests.some((request) => new URL(request.url).pathname.endsWith('/file/update/hash')));
	assert.ok(transport.requests.filter((request) => request.purpose === 'upload').length >= 2);
	assert.equal(transport.requests.filter((request) => request.purpose === 'upload' && request.method === 'PUT').length, 2);
	assert.ok(transport.requests.filter((request) => request.purpose === 'upload').every((request) => request.cookie === undefined));
	assert.ok(transport.requests.filter((request) => request.purpose !== 'upload').every((request) => request.cookie === 'sid=secret'));
	assert.ok(transport.requests.filter((request) => request.purpose === 'upload').every((request) => new URL(request.url).origin === 'https://bucket.pds.quark.cn'));
	assert.ok(transport.requests.filter((request) => request.purpose === 'upload').every((request) => request.url.startsWith('https://')));
	const commitBody = transport.requests.find((request) => request.purpose === 'upload' && request.method === 'POST')?.body;
	assert.match(new TextDecoder().decode(commitBody as Uint8Array), /<ETag>"a1b2c3"<\/ETag>/);

	for (const [hostHint, expectedOrigin] of [
		['oss-cn-hangzhou.aliyuncs.com', 'https://bucket.oss-cn-hangzhou.aliyuncs.com'],
		['https://pds.quark.cn', 'https://bucket.pds.quark.cn'],
	] as const) {
		const requestStart = transport.requests.length;
		uploaded = false;
		uploadUrl = hostHint;
		await client.uploadFile('blob-folder', 'blob.bin', new Uint8Array([1, 2]));
		const hostHintRequests = transport.requests.slice(requestStart).filter((request) => request.purpose === 'upload');
		assert.ok(hostHintRequests.length >= 2);
		assert.ok(hostHintRequests.every((request) => new URL(request.url).origin === expectedOrigin));
	}
});

test('upload rejects malformed or foreign upload hosts before contacting them', async () => {
	for (const uploadUrl of [
		'attacker.example.com',
		'pds.quark.cn/path',
		'pds.quark.cn?redirect=attacker.example.com',
		'user@pds.quark.cn',
		'pds.quark.cn:8443',
	]) {
		const transport = new FixtureTransport((request) => {
			const url = new URL(request.url);
			if (url.pathname.endsWith('/file/sort')) return response({ code: 0, data: { list: [], metadata: { _total: 0 } } });
			if (url.pathname.endsWith('/file/upload/pre')) {
				return response({ code: 0, data: { task_id: 'task', auth_info: 'auth', upload_id: 'upload', obj_key: 'object', bucket: 'bucket', upload_url: uploadUrl, callback: {} }, metadata: { part_size: 1 } });
			}
			if (url.pathname.endsWith('/file/update/hash')) return response({ code: 0, data: { finish: false } });
			throw new Error(`Unexpected fixture request: ${url.pathname}`);
		});

		await assert.rejects(() => new QuarkClient(transport, 'sid=secret').uploadFile('blob-folder', 'blob.bin', new Uint8Array([1, 2])), /夸克上传主机/);
		assert.equal(transport.requests.some((request) => request.purpose === 'upload'), false, uploadUrl);
	}
});

test('instant hash matches still notify finish when Quark supplies a task and object key', async () => {
	let uploaded = false;
	const transport = new FixtureTransport((request) => {
		const url = new URL(request.url);
		if (url.pathname.endsWith('/file/sort')) {
			return response({ code: 0, data: { list: uploaded ? [{ fid: 'blob-fid', file_name: 'blob.bin', file_type: 1, size: 2 }] : [], metadata: { _total: uploaded ? 1 : 0 } } });
		}
		if (url.pathname.endsWith('/file/upload/pre')) return response({ code: 0, data: { finish: true, task_id: 'task', obj_key: 'object', fid: 'blob-fid' } });
		if (url.pathname.endsWith('/file/upload/finish')) {
			uploaded = true;
			return response({ code: 0, data: { finish: true } });
		}
		throw new Error(`Unexpected fixture request: ${url.pathname}`);
	});
	await new QuarkClient(transport, 'sid=secret').uploadFile('blob-folder', 'blob.bin', new Uint8Array([1, 2]));
	assert.equal(transport.requests.filter((request) => new URL(request.url).pathname.endsWith('/file/upload/finish')).length, 1);
});

test('download refuses a URL returned for a different file and uses the approved cookie scope', async () => {
	const wrong = new FixtureTransport((request) => {
		if (new URL(request.url).pathname.endsWith('/file/download')) {
			return response({ code: 0, data: [{ fid: 'other-fid', download_url: 'https://bucket.pds.quark.cn/object', size: 3 }] });
		}
		return { status: 200, headers: {}, url: request.url, data: new Uint8Array([1, 2, 3]), text: () => '' };
	});
	await assert.rejects(
		() => new QuarkClient(wrong, 'sid=secret').downloadFile({ fid: 'wanted-fid', name: 'notes.md', isDirectory: false, size: 3 }),
		/未返回匹配文件/,
	);
	assert.equal(wrong.requests.some((request) => request.purpose === 'download'), false);

	const correct = new FixtureTransport((request) => {
		if (new URL(request.url).pathname.endsWith('/file/download')) {
			return response({ code: 0, data: [{ fid: 'wanted-fid', download_url: 'https://bucket.pds.quark.cn/object', size: 3 }] });
		}
		return { status: 200, headers: { 'content-type': 'application/octet-stream' }, url: request.url, data: new Uint8Array([1, 2, 3]), text: () => '' };
	});
	await new QuarkClient(correct, 'sid=secret').downloadFile({ fid: 'wanted-fid', name: 'notes.md', isDirectory: false, size: 3 });
	const downloadRequest = correct.requests.find((request) => request.purpose === 'download')!;
	assert.equal(downloadRequest.cookie, 'sid=secret');
	assert.equal(downloadRequest.headers?.Referer, 'https://pan.quark.cn/');
});


test('a forbidden file download renews its link once and preserves the signed URL exactly', async () => {
	const stale = 'https://bucket.pds.quark.cn/object?sig=old%2B%2F%3D&key=one+two';
	const fresh = 'https://bucket.pds.quark.cn/object?sig=new%2B%2F%3D&key=one+two';
	let links = 0;
	const transport = new FixtureTransport((request) => {
		if (request.purpose === 'api') {
			assert.deepEqual(JSON.parse(String(request.body)), { fids: ['file-id'] });
			return response({ code: 0, data: [{ fid: 'file-id', download_url: links++ === 0 ? stale : fresh }] });
		}
		if (request.url === stale) return response({}, 403);
		assert.equal(request.url, fresh);
		return { status: 200, headers: {}, url: request.url, data: Uint8Array.of(1, 2, 3), text: () => '' };
	});
	const bytes = await new QuarkClient(transport, 'sid=fixture').downloadFile({
		fid: 'file-id', name: 'manifest.json', isDirectory: false, size: 3,
	});
	assert.deepEqual(bytes, Uint8Array.of(1, 2, 3));
	assert.equal(links, 2);
});

test('a persistent forbidden download stops after one retry and exposes only a safe reason', async () => {
	const url = 'https://bucket.pds.quark.cn/object?sig=do-not-show';
	const body = '<Error><Code>SignatureDoesNotMatch</Code><Message>sid=do-not-show</Message></Error>';
	const transport = new FixtureTransport((request) => request.purpose === 'api'
		? response({ code: 0, data: [{ fid: 'file-id', download_url: url }] })
		: { status: 403, headers: {}, url, data: new TextEncoder().encode(body), text: () => body });
	await assert.rejects(
		() => new QuarkClient(transport, 'sid=fixture').downloadFile({
			fid: 'file-id', name: 'manifest.json', isDirectory: false, size: 3,
		}),
		(error: Error) => /403/.test(error.message) && /SignatureDoesNotMatch/.test(error.message) && !error.message.includes('do-not-show'),
	);
	assert.equal(transport.requests.length, 4);
});

test('an explicit Quark access denial is reported without making another download request', async () => {
	const url = 'https://bucket.pds.quark.cn/object';
	const transport = new FixtureTransport((request) => request.purpose === 'api'
		? response({ code: 0, data: [{ fid: 'file-id', download_url: url }] })
		: response({ code: 'AccessDenied', message: 'raw details' }, 403));
	await assert.rejects(
		() => new QuarkClient(transport, 'sid=fixture').downloadFile({
			fid: 'file-id', name: 'manifest.json', isDirectory: false, size: 3,
		}), /AccessDenied/,
	);
	assert.equal(transport.requests.length, 2);
});
