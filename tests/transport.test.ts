import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
	QuarkTransport,
	assertNoRedirect,
	classifyQuarkUrl,
	createSafeHeaders,
	normalizeNativeBody,
} from '../src/transport.ts';

test('cookie is attached only to exact Quark API hosts', () => {
	const headers = createSafeHeaders('https://drive-pc.quark.cn/api', 'a=1; b=2', { 'Content-Type': 'application/json' });
	assert.equal(headers.Cookie, 'a=1; b=2');
	assert.equal(createSafeHeaders('https://pan.quark.cn/account/info', 'a=1').Cookie, 'a=1');

	const transfer = createSafeHeaders('https://bucket.pds.quark.cn/object?signature=abc', 'a=1', {
		Authorization: 'signed-part',
		cookie: 'attacker=value',
	}, 'upload');
	assert.equal(transfer.Cookie, undefined);
	assert.equal(transfer.cookie, undefined);
	assert.equal(transfer.Authorization, 'signed-part');

	const download = createSafeHeaders('https://bucket.pds.quark.cn/object?ticket=abc', 'a=1', {}, 'download');
	assert.equal(download.Cookie, 'a=1');
	assert.deepEqual(classifyQuarkUrl('https://bucket.pds.quark.cn/object', 'download'), 'quark-download');
	assert.deepEqual(classifyQuarkUrl('https://bucket.pds.quark.cn/object', 'upload'), 'oss-upload');
	assert.deepEqual(classifyQuarkUrl('https://bucket.aliyuncs.com/object?sig=abc', 'upload'), 'oss-upload');
	assert.throws(() => classifyQuarkUrl('https://bucket.aliyuncs.com/object?sig=abc', 'download'), /主机/);
});

test('unapproved hosts and non-HTTPS URLs are rejected before sending credentials', () => {
	assert.throws(() => classifyQuarkUrl('https://drive-pc.quark.cn.evil.example/api'), /主机/);
	assert.throws(() => classifyQuarkUrl('https://example.com/download'), /主机/);
	assert.throws(() => classifyQuarkUrl('http://drive-pc.quark.cn/api'), /HTTPS/);
	assert.throws(() => classifyQuarkUrl('https://user:pass@drive-pc.quark.cn/api'), /主机/);
});

test('QR login has a separate exact endpoint allowlist and never attaches the saved Cookie', () => {
	const uop = 'https://uop.quark.cn/cas/ajax/getTokenForQrcodeLogin?client_id=532';
	const pan = 'https://pan.quark.cn/account/info?lw=scan';
	assert.equal(classifyQuarkUrl(uop, 'login'), 'quark-login');
	assert.equal(classifyQuarkUrl(pan, 'login'), 'quark-login');
	assert.equal(createSafeHeaders(uop, 'sid=secret', {}, 'login').Cookie, undefined);
	assert.equal(createSafeHeaders(pan, 'sid=secret', {}, 'login').Cookie, undefined);
	assert.throws(() => classifyQuarkUrl('https://uop.quark.cn/cas/ajax/other', 'login'), /主机/);
	assert.throws(() => classifyQuarkUrl('https://drive-pc.quark.cn/1/clouddrive/file/sort', 'login'), /主机/);
	assert.throws(() => classifyQuarkUrl('https://pan.quark.cn/other', 'login'), /主机/);
});

test('redirect responses fail closed rather than forwarding the original cookie', () => {
	assert.throws(() => assertNoRedirect(302, 'https://evil.example/collect'), /重定向/);
	assert.doesNotThrow(() => assertNoRedirect(200));
});

test('native JSON objects are serialized for text callers and base64 binaries are decoded for hashing', () => {
	assert.equal(new TextDecoder().decode(normalizeNativeBody({ ok: true, count: 2 }, 'text', 'application/json')), '{"ok":true,"count":2}');
	assert.deepEqual([...normalizeNativeBody('AP8=', 'arraybuffer', 'application/octet-stream')], [0, 255]);
	assert.equal(new TextDecoder().decode(normalizeNativeBody('hello', 'text', 'text/plain')), 'hello');
});


async function withNativeHttp(
	request: (options: Record<string, unknown>) => Record<string, unknown>,
	verify: () => Promise<void>,
): Promise<void> {
	const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: { Capacitor: {
			isNativePlatform: () => true,
			Plugins: { CapacitorHttp: { request: async (options: Record<string, unknown>) => request(options) } },
		} },
	});
	try {
		await verify();
	} finally {
		if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
		else Reflect.deleteProperty(globalThis, 'window');
	}
}

async function withDesktopHttps(
	contentLength: string,
	bodyChunk: Uint8Array,
	verify: (wasDestroyed: () => boolean) => Promise<void>,
): Promise<void> {
	const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
	let callback: ((incoming: unknown) => void) | undefined;
	let outboundDestroyed = false;
	let incomingDestroyed = false;
	const incoming = new EventEmitter() as EventEmitter & {
		statusCode: number;
		headers: Record<string, string>;
		destroy: () => void;
	};
	incoming.statusCode = 200;
	incoming.headers = { 'content-length': contentLength };
	incoming.destroy = () => { incomingDestroyed = true; };
	const outbound = new EventEmitter() as EventEmitter & {
		write: (_body: unknown) => void;
		end: () => void;
		destroy: () => void;
	};
	outbound.write = () => undefined;
	outbound.end = () => {
		queueMicrotask(() => {
			callback?.(incoming);
			if (!incomingDestroyed) {
				incoming.emit('data', bodyChunk);
				incoming.emit('end');
			}
		});
	};
	outbound.destroy = () => { outboundDestroyed = true; };
	const fakeHttps = {
		request: (_options: unknown, onResponse: (incoming: unknown) => void) => {
			callback = onResponse;
			return outbound;
		},
	} as unknown as typeof import('node:https');
	const fakeRequire = ((_name: 'node:https') => fakeHttps) as unknown as (name: 'node:https') => typeof import('node:https');
	Object.defineProperty(globalThis, 'window', { configurable: true, value: { require: fakeRequire } });
	try {
		await verify(() => outboundDestroyed);
	} finally {
		if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
		else Reflect.deleteProperty(globalThis, 'window');
	}
}

test('Android download failures keep native error text intact and send the original URL', async () => {
	const url = 'https://bucket.pds.quark.cn/object?sign=ab%2B%2F%3D&key=a+b';
	await withNativeHttp((options) => {
		assert.equal(options.url, url);
		assert.equal(options.disableRedirects, true);
		return { status: 403, url, data: 'AccessDenied', headers: { 'content-type': 'text/plain' } };
	}, async () => {
		const response = await new QuarkTransport('android').request({
			url, method: 'GET', cookie: 'sid=fixture', purpose: 'download', responseKind: 'arraybuffer',
		});
		assert.equal(response.status, 403);
		assert.equal(response.text(), 'AccessDenied');
	});
});

test('iOS decodes a Base64 download failure returned by its native bridge', async () => {
	const url = 'https://bucket.pds.quark.cn/object?sign=ab%2B%2F%3D&key=a+b';
	const denial = '<Error><Code>AccessDenied</Code></Error>';
	await withNativeHttp((options) => {
		assert.equal(options.url, url);
		assert.equal(options.responseType, 'arraybuffer');
		assert.equal(options.disableRedirects, true);
		return { status: 403, url, data: btoa(denial), headers: { 'content-type': 'application/xml' } };
	}, async () => {
		const response = await new QuarkTransport('ios').request({
			url, method: 'GET', cookie: 'sid=fixture', purpose: 'download', responseKind: 'arraybuffer',
		});
		assert.equal(response.status, 403);
		assert.equal(response.text(), denial);
	});
});

test('iOS passes raw upload bytes using Capacitor file mode and keeps redirects disabled', async () => {
	const url = 'https://bucket.pds.quark.cn/object?partNumber=1';
	await withNativeHttp((options) => {
		assert.equal(options.method, 'PUT');
		assert.equal(options.url, url);
		assert.equal(options.disableRedirects, true);
		assert.equal(options.dataType, 'file');
		assert.equal(options.data, 'AP/+');
		assert.deepEqual(options.headers, { 'Content-Type': 'application/octet-stream', Authorization: 'signed-part' });
		return { status: 200, url, data: '', headers: { ETag: 'uploaded-part' } };
	}, async () => {
		const response = await new QuarkTransport('ios').request({
			url, method: 'PUT', cookie: 'sid=fixture', purpose: 'upload', body: Uint8Array.of(0, 255, 254),
			headers: { 'Content-Type': 'application/octet-stream', Authorization: 'signed-part' },
		});
		assert.equal(response.headers.etag, 'uploaded-part');
	});
});

test('anonymous share purposes are restricted to the verified Pan routes and preview CDN hosts', () => {
	assert.equal(classifyQuarkUrl('https://pan.quark.cn/1/clouddrive/share/sharepage/token', 'share-api'), 'quark-share-api');
	assert.equal(classifyQuarkUrl('https://pan.quark.cn/1/clouddrive/share/sharepage/detail', 'share-api'), 'quark-share-api');
	assert.equal(classifyQuarkUrl('https://img-view-c-zb.drive.quark.cn/p/opaque', 'share-preview'), 'quark-share-preview');
	assert.equal(classifyQuarkUrl('https://img-view-c-sz.drive.quark.cn/p/opaque', 'share-preview'), 'quark-share-preview');
	assert.equal(classifyQuarkUrl('https://dl-c-sz-u.drive.quark.cn/p/opaque', 'share-preview'), 'quark-share-preview');
	assert.equal(createSafeHeaders('https://pan.quark.cn/1/clouddrive/share/sharepage/token', 'sid=secret', {}, 'share-api').Cookie, undefined);
	assert.equal(createSafeHeaders('https://img-view-c-zb.drive.quark.cn/p/opaque', 'sid=secret', {}, 'share-preview').Cookie, undefined);
	assert.throws(() => classifyQuarkUrl('https://pan.quark.cn/account/info', 'share-api'), /主机/);
	assert.throws(() => classifyQuarkUrl('https://dl-guest-zb-u.drive.quark.cn/p/opaque', 'share-preview'), /主机/);
	assert.throws(() => classifyQuarkUrl('https://img-view-c-xx.drive.quark.cn/p/opaque', 'share-preview'), /主机/);
	assert.throws(() => classifyQuarkUrl('https://pan.quark.cn/1/clouddrive/share/sharepage/token', 'share-preview'), /主机/);
});

test('share transport accepts only the probed methods and applies a strict response byte cap', async () => {
	await assert.rejects(() => new QuarkTransport('desktop').request({
		url: 'https://pan.quark.cn/1/clouddrive/share/sharepage/token', method: 'GET', purpose: 'share-api',
	}), /固定|仅允许/);

	const url = 'https://img-view-c-zb.drive.quark.cn/p/opaque';
	await withNativeHttp((options) => {
		assert.equal(options.url, url);
		assert.deepEqual(options.headers, {});
		return { status: 200, url, data: new Uint8Array([1, 2, 3]), headers: { 'content-type': 'image/png', 'content-length': '3' } };
	}, async () => {
		await assert.rejects(() => new QuarkTransport('ios').request({
			url, method: 'GET', cookie: 'sid=secret', purpose: 'share-preview', responseKind: 'arraybuffer', maxResponseBytes: 2,
		}), /大小限制/);
	});
});

test('desktop share preview checks declared and streamed lengths before buffering over-limit bodies', async () => {
	const url = 'https://img-view-c-zb.drive.quark.cn/p/opaque';
	for (const [contentLength, bytes] of [['3', Uint8Array.of(1, 2, 3)], ['1', Uint8Array.of(1, 2, 3)]] as const) {
		await withDesktopHttps(contentLength, bytes, async (wasDestroyed) => {
			await assert.rejects(() => new QuarkTransport('desktop').request({
				url, method: 'GET', purpose: 'share-preview', responseKind: 'arraybuffer', maxResponseBytes: 2,
			}), /大小限制/);
			assert.equal(wasDestroyed(), true);
		});
	}
});


test('Quark signed download CDN is download-only and receives no drive session', () => {
	for (const host of ['dl-c-sz-u.drive.quark.cn', 'dl-c-zb-u.drive.quark.cn']) {
		const url = `https://${host}/opaque?ticket=fixture`;
		assert.equal(classifyQuarkUrl(url, 'download'), 'quark-signed-download');
		assert.deepEqual(createSafeHeaders(url, '__puus=fixture', { Cookie: 'override' }, 'download'), {});
		assert.throws(() => classifyQuarkUrl(url, 'api'), /主机/);
		assert.throws(() => classifyQuarkUrl(url, 'upload'), /主机/);
	}
	assert.throws(() => classifyQuarkUrl('https://dl-c-zb-u.drive.quark.cn.example.com/', 'download'), /主机/);
});
