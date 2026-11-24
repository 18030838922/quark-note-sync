import assert from 'node:assert/strict';
import test from 'node:test';
import type { HttpRequest, HttpResponse } from '../src/transport.ts';
import { QuarkQrLogin } from '../src/quark-login.ts';

class FixtureTransport {
	requests: HttpRequest[] = [];
	private readonly responder: (request: HttpRequest, index: number) => HttpResponse;

	constructor(responder: (request: HttpRequest, index: number) => HttpResponse) {
		this.responder = responder;
	}

	async request(request: HttpRequest): Promise<HttpResponse> {
		this.requests.push(request);
		return this.responder(request, this.requests.length - 1);
	}
}

const response = (body: unknown, headers: Record<string, string> = {}, status = 200): HttpResponse => {
	const text = JSON.stringify(body);
	return { status, headers, url: '', data: new TextEncoder().encode(text), text: () => text };
};

test('normal Quark QR login creates a local scan URL from the public token response', async () => {
	const transport = new FixtureTransport(() => response({
		status: 2000000,
		data: { members: { token: 'fixture-token' } },
	}));
	const login = new QuarkQrLogin(transport);
	const session = await login.createSession(1000);
	const request = transport.requests[0];
	const requestUrl = new URL(request.url);

	assert.equal(request.method, 'GET');
	assert.equal(request.purpose, 'login');
	assert.equal(requestUrl.origin, 'https://uop.quark.cn');
	assert.equal(requestUrl.pathname, '/cas/ajax/getTokenForQrcodeLogin');
	assert.equal(requestUrl.searchParams.get('client_id'), '532');
	assert.equal(requestUrl.searchParams.get('v'), '1.2');
	assert.ok(requestUrl.searchParams.get('request_id'));
	assert.equal(request.cookie, undefined);
	assert.equal(new URL(session.qrUrl).origin, 'https://su.quark.cn');
	assert.equal(new URL(session.qrUrl).pathname, '/4_eMHBJ');
	assert.equal(new URL(session.qrUrl).searchParams.get('token'), 'fixture-token');
	assert.equal(session.expiresAt - session.createdAt, 5 * 60_000);
});

test('polling distinguishes waiting, approval, expiry, and cancellation without sending a Cookie', async () => {
	const statuses = [50004001, 2000000, 50004002, 50004004];
	const transport = new FixtureTransport((_request, index) => response({
		status: index === 0 ? 2000000 : statuses[index - 1],
		data: { members: index === 2 ? { service_ticket: 'fixture-ticket' } : index === 0 ? { token: 'fixture-token' } : {} },
	}));
	const login = new QuarkQrLogin(transport);
	const session = await login.createSession();
	for (let index = 0; index < statuses.length; index += 1) {
		const result = await login.poll(session);
		assert.equal(result.state, ['pending', 'approved', 'expired', 'cancelled'][index]);
		assert.equal(transport.requests[index + 1].cookie, undefined);
	}
});

test('ticket exchange carries the ticket only to the fixed Quark account endpoint and filters cookies', async () => {
	const transport = new FixtureTransport((request) => {
		const url = new URL(request.url);
		assert.equal(url.origin, 'https://pan.quark.cn');
		assert.equal(url.pathname, '/account/info');
		assert.equal(url.searchParams.get('st'), 'fixture-ticket');
		assert.equal(url.searchParams.get('lw'), 'scan');
		assert.equal(request.cookie, undefined);
		return response({ status: 2000000, data: { ok: true } }, {
			'set-cookie': '__pus=primary; Path=/; HttpOnly\n__kps=session; Path=/\n__uid=12345; Path=/\nother_session=must-not-copy; Path=/',
		});
	});
	const cookie = await new QuarkQrLogin(transport).exchangeTicket('fixture-ticket');
	assert.equal(cookie, '__pus=primary; __kps=session; __uid=12345');
	assert.equal(cookie.includes('other_session'), false);
});

test('ticket exchange refuses responses without an approved webpage session cookie', async () => {
	const transport = new FixtureTransport(() => response({ status: 2000000 }, {
		'set-cookie': 'analytics=unrelated; Path=/\n__uid=12345; Path=/',
	}));
	await assert.rejects(() => new QuarkQrLogin(transport).exchangeTicket('fixture-ticket'), /没有返回可用会话/);
});

test('unsafe login response status and malformed bodies fail without exposing credentials', async () => {
	const statusFailure = new FixtureTransport(() => response({ status: 50004003, message: 'fixture-token should not leak' }));
	await assert.rejects(
		() => new QuarkQrLogin(statusFailure).createSession(),
		(error: Error) => error.message.includes('二维码') && !error.message.includes('fixture-token'),
	);
	const malformed = new FixtureTransport(() => ({ status: 200, headers: {}, url: '', data: new TextEncoder().encode('not json'), text: () => 'not json' }));
	await assert.rejects(() => new QuarkQrLogin(malformed).createSession(), /无法解析/);
});
