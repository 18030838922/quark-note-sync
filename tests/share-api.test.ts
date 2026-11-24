import assert from 'node:assert/strict';
import test from 'node:test';
import type { HttpRequest, HttpResponse } from '../src/transport.ts';
import { classifyQuarkUrl, createSafeHeaders } from '../src/transport.ts';
import { QuarkShareClient, ShareApiError } from '../src/share-api.ts';

class FixtureTransport {
	readonly requests: HttpRequest[] = [];
	private readonly responder: (request: HttpRequest, index: number) => HttpResponse;

	constructor(responder: (request: HttpRequest, index: number) => HttpResponse) {
		this.responder = responder;
	}

	async request(request: HttpRequest): Promise<HttpResponse> {
		this.requests.push(request);
		return this.responder(request, this.requests.length - 1);
	}
}

const jsonResponse = (body: unknown, status = 200): HttpResponse => {
	const text = JSON.stringify(body);
	const data = new TextEncoder().encode(text);
	return { status, headers: { 'content-type': 'application/json' }, url: '', data, text: () => text };
};

const binaryResponse = (bytes: Uint8Array, mimeType: string, status = 200): HttpResponse => ({
	status,
	headers: { 'content-type': mimeType, 'content-length': String(bytes.byteLength) },
	url: '',
	data: bytes,
	text: () => new TextDecoder().decode(bytes),
});

const session = { pwdId: 'share-id', stoken: 'memory-only-token' } as const;
const imageEntry = { fid: 'image-id', name: 'photo.png', isDirectory: false, size: 12, fidToken: 'fid-token' } as const;
const pdfEntry = { fid: 'pdf-id', name: 'report.pdf', isDirectory: false, size: 9, fidToken: 'pdf-token' } as const;
const pngBytes = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4);
const pdfBytes = new TextEncoder().encode('%PDF-1.7\n');

test('anonymous share purposes allow only the probed Pan and preview hosts without cookies', () => {
	assert.equal(classifyQuarkUrl('https://pan.quark.cn/1/clouddrive/share/sharepage/token', 'share-api'), 'quark-share-api');
	assert.equal(classifyQuarkUrl('https://pan.quark.cn/1/clouddrive/share/sharepage/detail', 'share-api'), 'quark-share-api');
	assert.equal(classifyQuarkUrl('https://img-view-c-zb.drive.quark.cn/signed/image', 'share-preview'), 'quark-share-preview');
	assert.equal(classifyQuarkUrl('https://img-view-c-sz.drive.quark.cn/signed/image', 'share-preview'), 'quark-share-preview');
	assert.equal(classifyQuarkUrl('https://dl-c-sz-u.drive.quark.cn/signed/pdf', 'share-preview'), 'quark-share-preview');
	assert.equal(createSafeHeaders('https://pan.quark.cn/1/clouddrive/share/sharepage/token', 'sid=secret', { Cookie: 'override=secret' }, 'share-api').Cookie, undefined);
	assert.equal(createSafeHeaders('https://img-view-c-zb.drive.quark.cn/signed/image', 'sid=secret', {}, 'share-preview').Cookie, undefined);
	assert.throws(() => classifyQuarkUrl('https://pan.quark.cn/account/info', 'share-api'), /主机/);
	assert.throws(() => classifyQuarkUrl('https://dl-guest-zb-u.drive.quark.cn/signed/file', 'share-preview'), /主机/);
	assert.throws(() => classifyQuarkUrl('https://img-view-c-xx.drive.quark.cn/signed/image', 'share-preview'), /主机/);
	assert.throws(() => classifyQuarkUrl('https://img-view-c-zb.drive.quark.cn/signed/image', 'share-api'), /主机/);
});

test('opening a share sends the passcode anonymously and keeps only the returned session in memory', async () => {
	const transport = new FixtureTransport((request) => jsonResponse({ code: 0, data: { stoken: 'ephemeral-stoken' } }));
	const client = new QuarkShareClient(transport);
	const result = await client.openShare('share-id', '1234');

	assert.deepEqual(result, { pwdId: 'share-id', stoken: 'ephemeral-stoken' });
	assert.equal(transport.requests.length, 1);
	const request = transport.requests[0];
	const url = new URL(request.url);
	assert.equal(request.method, 'POST');
	assert.equal(url.origin, 'https://pan.quark.cn');
	assert.equal(url.pathname, '/1/clouddrive/share/sharepage/token');
	assert.equal(url.searchParams.get('pr'), 'ucpro');
	assert.equal(url.searchParams.get('fr'), 'pc');
	assert.deepEqual(JSON.parse(String(request.body)), { pwd_id: 'share-id', passcode: '1234' });
	assert.equal(request.purpose, 'share-api');
	assert.equal(request.cookie, undefined);
	assert.equal('cookie' in result, false);
});

test('opening an unprotected share sends an empty passcode without adding credentials', async () => {
	const transport = new FixtureTransport((request) => jsonResponse({ code: 0, data: { stoken: 'no-code-stoken' } }));
	const result = await new QuarkShareClient(transport).openShare('public-share', '');
	assert.equal(result.stoken, 'no-code-stoken');
	assert.deepEqual(JSON.parse(String(transport.requests[0].body)), { pwd_id: 'public-share', passcode: '' });
	assert.equal(transport.requests[0].cookie, undefined);
});

test('share code failures map to safe typed errors without exposing secret response text', async () => {
	for (const [code, reason] of [[41008, 'passcode'], [41006, 'missing'], [41019, 'expired']] as const) {
		const transport = new FixtureTransport(() => jsonResponse({ code, message: 'do-not-leak-stoken-secret' }, 404));
		await assert.rejects(
			() => new QuarkShareClient(transport).openShare('share-id', 'sensitive-passcode'),
			(error: Error) => error instanceof ShareApiError
				&& error.reason === reason
				&& !error.message.includes('sensitive-passcode')
				&& !error.message.includes('do-not-leak-stoken-secret'),
		);
	}
});

test('directory listing paginates and returns only normalized ephemeral share entries', async () => {
	const transport = new FixtureTransport((request, index) => {
		const url = new URL(request.url);
		assert.equal(request.purpose, 'share-api');
		assert.equal(request.cookie, undefined);
		assert.equal(url.pathname, '/1/clouddrive/share/sharepage/detail');
		assert.equal(url.searchParams.get('pwd_id'), session.pwdId);
		assert.equal(url.searchParams.get('stoken'), session.stoken);
		assert.equal(url.searchParams.get('pdir_fid'), 'folder-id');
		const page = url.searchParams.get('_page');
		assert.equal(page, String(index + 1));
		const list = index === 0
			? Array.from({ length: 50 }, (_, item) => ({ fid: `file-${item}`, file_name: `file-${item}.txt`, dir: false, size: 20, share_fid_token: `token-${item}` }))
			: [{ fid: 'folder', file_name: 'Folder', dir: true, size: 0, share_fid_token: 'folder-token' }];
		return jsonResponse({ code: 0, data: { list }, metadata: { _total: 51 } });
	});

	const result = await new QuarkShareClient(transport).listDirectory(session, 'folder-id');
	assert.equal(result.length, 51);
	assert.deepEqual(result[0], { fid: 'file-0', name: 'file-0.txt', isDirectory: false, size: 20, fidToken: 'token-0' });
	assert.deepEqual(result[50], { fid: 'folder', name: 'Folder', isDirectory: true, size: 0, fidToken: 'folder-token' });
});

test('image preview uses the matching share token, a bounded anonymous CDN read, and validates PNG bytes', async () => {
	const transport = new FixtureTransport((request) => {
		const url = new URL(request.url);
		if (url.hostname === 'pan.quark.cn') {
			assert.equal(request.method, 'GET');
			assert.equal(request.purpose, 'share-api');
			assert.equal(url.pathname, '/1/clouddrive/share/sharepage/preview');
			assert.equal(url.searchParams.get('pwd_id'), session.pwdId);
			assert.equal(url.searchParams.get('stoken'), session.stoken);
			assert.equal(url.searchParams.get('fid_list'), imageEntry.fid);
			assert.equal(url.searchParams.get('fid_token_list'), imageEntry.fidToken);
			assert.equal(url.searchParams.get('format'), 'png');
			return jsonResponse({ code: 0, data: [{ fid: imageEntry.fid, preview_url: 'https://img-view-c-sz.drive.quark.cn/signed/image?sig=opaque' }] });
		}
		assert.equal(request.purpose, 'share-preview');
		assert.equal(request.cookie, undefined);
		assert.equal(request.maxResponseBytes, 20 * 1024 * 1024);
		assert.equal(url.hostname, 'img-view-c-sz.drive.quark.cn');
		return binaryResponse(pngBytes, 'image/png');
	});

	const result = await new QuarkShareClient(transport).previewDocumentOrImage(session, imageEntry);
	assert.deepEqual(result, { bytes: pngBytes, mimeType: 'image/png' });
});

test('PDF preview fetches only the verified PDF CDN host and checks bytes against the listed size', async () => {
	const transport = new FixtureTransport((request) => {
		const url = new URL(request.url);
		if (url.hostname === 'pan.quark.cn') {
			assert.equal(url.pathname, '/1/clouddrive/share/sharepage/pdf_preview');
			assert.equal(url.searchParams.get('fid'), pdfEntry.fid);
			assert.equal(url.searchParams.get('fid_token'), pdfEntry.fidToken);
			assert.equal(url.searchParams.get('fid_list'), pdfEntry.fid);
			assert.equal(url.searchParams.get('fid_token_list'), pdfEntry.fidToken);
			return jsonResponse({ code: 0, data: { download_url: 'https://dl-c-sz-u.drive.quark.cn/signed/report?sig=opaque' } });
		}
		assert.equal(url.hostname, 'dl-c-sz-u.drive.quark.cn');
		assert.equal(request.purpose, 'share-preview');
		assert.equal(request.cookie, undefined);
		assert.equal(request.maxResponseBytes, 20 * 1024 * 1024);
		return binaryResponse(pdfBytes, 'application/pdf');
	});

	const result = await new QuarkShareClient(transport).previewDocumentOrImage(session, pdfEntry);
	assert.deepEqual(result, { bytes: pdfBytes, mimeType: 'application/pdf' });
});

test('preview rejects transformed image data as an original download and refuses oversized preview bytes', async () => {
	const imageTransport = new FixtureTransport((request) => new URL(request.url).hostname === 'pan.quark.cn'
		? jsonResponse({ code: 0, data: [{ fid: imageEntry.fid, preview_url: 'https://img-view-c-zb.drive.quark.cn/photo' }] })
		: binaryResponse(pngBytes, 'image/png'));
	await assert.rejects(
		() => new QuarkShareClient(imageTransport).downloadFile(session, imageEntry, 1024),
		(error: Error) => error instanceof ShareApiError && error.reason === 'unsupported',
	);
	assert.equal(imageTransport.requests.length, 0);

	const oversized = new Uint8Array(20 * 1024 * 1024 + 1);
	oversized.set(pngBytes);
	const tooLargeTransport = new FixtureTransport((request) => new URL(request.url).hostname === 'pan.quark.cn'
		? jsonResponse({ code: 0, data: [{ fid: imageEntry.fid, preview_url: 'https://img-view-c-zb.drive.quark.cn/photo' }] })
		: binaryResponse(oversized, 'image/png'));
	await assert.rejects(
		() => new QuarkShareClient(tooLargeTransport).previewDocumentOrImage(session, imageEntry),
		(error: Error) => error instanceof ShareApiError && error.reason === 'unsupported',
	);
});

test('downloadFile returns only full-size PDFs and fails closed when a signed URL is unsafe or inconsistent', async () => {
	const correct = new FixtureTransport((request) => new URL(request.url).hostname === 'pan.quark.cn'
		? jsonResponse({ code: 0, data: { fid: pdfEntry.fid, download_url: 'https://dl-c-sz-u.drive.quark.cn/signed/report' } })
		: binaryResponse(pdfBytes, 'application/pdf'));
	assert.deepEqual(await new QuarkShareClient(correct).downloadFile(session, pdfEntry, 64), {
		bytes: pdfBytes,
		mimeType: 'application/pdf',
	});
	assert.equal(correct.requests[1].maxResponseBytes, 64);

	const wrongHost = new FixtureTransport((request) => jsonResponse({ code: 0, data: { fid: pdfEntry.fid, download_url: 'https://dl-guest-zb-u.drive.quark.cn/original' } }));
	await assert.rejects(
		() => new QuarkShareClient(wrongHost).downloadFile(session, pdfEntry, 64),
		(error: Error) => error instanceof ShareApiError && error.reason === 'unsupported',
	);
	assert.equal(wrongHost.requests.length, 1);

	const wrongLength = new FixtureTransport((request) => new URL(request.url).hostname === 'pan.quark.cn'
		? jsonResponse({ code: 0, data: { fid: pdfEntry.fid, download_url: 'https://dl-c-sz-u.drive.quark.cn/signed/report' } })
		: binaryResponse(new TextEncoder().encode('%PDF'), 'application/pdf'));
	await assert.rejects(
		() => new QuarkShareClient(wrongLength).downloadFile(session, pdfEntry, 64),
		(error: Error) => error instanceof ShareApiError && error.reason === 'unsupported',
	);
});
