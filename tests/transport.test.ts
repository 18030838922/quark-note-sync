import assert from 'node:assert/strict';
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


test('Android download failures keep native error text intact and send the original URL', async () => {
	const url = 'https://bucket.pds.quark.cn/object?sign=ab%2B%2F%3D&key=a+b';
	const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: { Capacitor: {
			isNativePlatform: () => true,
			Plugins: { CapacitorHttp: { async request(options: Record<string, unknown>) {
				assert.equal(options.url, url);
				assert.equal(options.disableRedirects, true);
				return { status: 403, url, data: 'AccessDenied', headers: { 'content-type': 'text/plain' } };
			} } },
		} },
	});
	try {
		const response = await new QuarkTransport(true).request({
			url, method: 'GET', cookie: 'sid=fixture', purpose: 'download', responseKind: 'arraybuffer',
		});
		assert.equal(response.status, 403);
		assert.equal(response.text(), 'AccessDenied');
	} finally {
		if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
		else Reflect.deleteProperty(globalThis, 'window');
	}
});
