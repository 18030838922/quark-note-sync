import type { HttpRequest, HttpResponse } from './transport.ts';

const UOP_ORIGIN = 'https://uop.quark.cn';
const PAN_ORIGIN = 'https://pan.quark.cn';
const QR_LOGIN_URL = 'https://su.quark.cn/4_eMHBJ';
const CLIENT_ID = '532';
const API_VERSION = '1.2';
const QR_LIFETIME_MS = 5 * 60_000;
const LOGIN_COOKIE_NAMES = new Set(['__pus', '__puus', '__kps', '__uid']);

export interface QuarkQrSession {
	token: string;
	qrUrl: string;
	createdAt: number;
	expiresAt: number;
}

export type QuarkQrPollResult =
	| { state: 'pending' }
	| { state: 'expired' }
	| { state: 'cancelled' }
	| { state: 'approved'; serviceTicket: string };

export interface HttpRequester {
	request(request: HttpRequest): Promise<HttpResponse>;
}

/** Implements only Quark's ordinary web QR login and session exchange endpoints. */
export class QuarkQrLogin {
	private readonly transport: HttpRequester;

	constructor(transport: HttpRequester) {
		this.transport = transport;
	}

	async createSession(now = Date.now()): Promise<QuarkQrSession> {
		const requestId = createRequestId();
		const url = new URL(`${UOP_ORIGIN}/cas/ajax/getTokenForQrcodeLogin`);
		url.searchParams.set('client_id', CLIENT_ID);
		url.searchParams.set('v', API_VERSION);
		url.searchParams.set('request_id', requestId);
		const envelope = await this.requestJson({ url: url.toString(), method: 'GET', purpose: 'login' });
		assertBusinessSuccess(envelope);
		const token = readString(envelope, ['token']);
		if (!token || token.length > 1024 || /[\r\n\u0000-\u001f\u007f]/.test(token)) {
			throw new Error('夸克未返回有效二维码凭据');
		}
		const qrUrl = new URL(QR_LOGIN_URL);
		qrUrl.searchParams.set('token', token);
		qrUrl.searchParams.set('client_id', CLIENT_ID);
		qrUrl.searchParams.set('ssb', 'weblogin');
		qrUrl.searchParams.set('uc_param_str', '');
		qrUrl.searchParams.set('uc_biz_str', 'S:custom|OPT:SAREA@0|OPT:IMMERSIVE@1|OPT:BACK_BTN_STYLE@0');
		return { token, qrUrl: qrUrl.toString(), createdAt: now, expiresAt: now + QR_LIFETIME_MS };
	}

	async poll(session: QuarkQrSession): Promise<QuarkQrPollResult> {
		if (!session.token || session.token.length > 1024 || /[\r\n\u0000-\u001f\u007f]/.test(session.token)) {
			throw new Error('二维码登录状态无效');
		}
		const url = new URL(`${UOP_ORIGIN}/cas/ajax/getServiceTicketByQrcodeToken`);
		url.searchParams.set('client_id', CLIENT_ID);
		url.searchParams.set('v', API_VERSION);
		url.searchParams.set('token', session.token);
		url.searchParams.set('request_id', createRequestId());
		const envelope = await this.requestJson({ url: url.toString(), method: 'GET', purpose: 'login' });
		const status = readBusinessStatus(envelope);
		if (status === 50004001) return { state: 'pending' };
		if (status === 50004002) return { state: 'expired' };
		if (status === 50004004) return { state: 'cancelled' };
		if (status !== 2000000) throw new Error('夸克二维码登录检查失败');
		const serviceTicket = readString(envelope, ['service_ticket', 'serviceTicket']);
		if (!serviceTicket || serviceTicket.length > 2048 || /[\r\n\u0000-\u001f\u007f]/.test(serviceTicket)) {
			throw new Error('夸克未返回有效登录凭据');
		}
		return { state: 'approved', serviceTicket };
	}

	async exchangeTicket(serviceTicket: string): Promise<string> {
		if (!serviceTicket || serviceTicket.length > 2048 || /[\r\n\u0000-\u001f\u007f]/.test(serviceTicket)) {
			throw new Error('夸克登录凭据无效');
		}
		const url = new URL(`${PAN_ORIGIN}/account/info`);
		url.searchParams.set('st', serviceTicket);
		url.searchParams.set('lw', 'scan');
		url.searchParams.set('fr', 'pc');
		url.searchParams.set('platform', 'pc');
		const response = await this.request({
			url: url.toString(),
			method: 'GET',
			purpose: 'login',
			headers: {
				Accept: 'application/json, text/plain, */*',
				Origin: PAN_ORIGIN,
				Referer: `${PAN_ORIGIN}/`,
			},
		});
		if (response.status < 200 || response.status >= 300) throw new Error('夸克网页登录凭据交换失败');
		readJson(response);
		const cookie = selectLoginCookies(response.headers['set-cookie'] ?? response.headers['Set-Cookie']);
		if (!cookie) throw new Error('夸克网页登录没有返回可用会话');
		return cookie;
	}

	private async requestJson(request: HttpRequest): Promise<Record<string, unknown>> {
		const response = await this.request({
			...request,
			headers: {
				Accept: 'application/json, text/plain, */*',
				Origin: `${UOP_ORIGIN}`,
				Referer: `${PAN_ORIGIN}/`,
			},
		});
		if (response.status < 200 || response.status >= 300) throw new Error('夸克二维码登录请求失败');
		return readJson(response);
	}

	private async request(request: HttpRequest): Promise<HttpResponse> {
		try {
			return await this.transport.request(request);
		} catch (error) {
			if (error instanceof Error && /重定向|允许列表|HTTPS/.test(error.message)) throw error;
			throw new Error('连接夸克二维码登录服务失败');
		}
	}
}

function readJson(response: HttpResponse): Record<string, unknown> {
	try {
		const value = JSON.parse(response.text()) as unknown;
		return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
	} catch {
		throw new Error('夸克二维码登录响应无法解析');
	}
}

function assertBusinessSuccess(envelope: Record<string, unknown>): void {
	if (readBusinessStatus(envelope) !== 2000000) throw new Error('夸克未能创建登录二维码');
}

function readBusinessStatus(envelope: Record<string, unknown>): number | undefined {
	for (const value of [envelope.status, envelope.code, envelope.data && (envelope.data as Record<string, unknown>).status]) {
		const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,12}$/.test(value) ? Number(value) : NaN;
		if (Number.isSafeInteger(number)) return number;
	}
	return undefined;
}

function readString(envelope: Record<string, unknown>, keys: string[]): string | undefined {
	const queue: unknown[] = [envelope.data, envelope];
	const visited = new Set<object>();
	for (let index = 0; index < queue.length && index < 32; index += 1) {
		const value = queue[index];
		if (!value || typeof value !== 'object' || Array.isArray(value) || visited.has(value)) continue;
		visited.add(value);
		const record = value as Record<string, unknown>;
		for (const [key, candidate] of Object.entries(record)) {
			if (keys.includes(key) && typeof candidate === 'string' && candidate.trim()) return candidate.trim();
			if (candidate && typeof candidate === 'object') queue.push(candidate);
		}
	}
	return undefined;
}

function selectLoginCookies(header: string | undefined): string | undefined {
	if (!header) return undefined;
	const entries = new Map<string, string>();
	const lines = header.split(/[\r\n]+/).flatMap((line) => line.split(/,\s*(?=[!#$%&'*+.^_`|~0-9A-Za-z-]+=)/));
	for (const line of lines) {
		const pair = /^\s*([^=;\s]+)=([^;\r\n]*)/.exec(line);
		if (!pair || !LOGIN_COOKIE_NAMES.has(pair[1])) continue;
		const value = pair[2].trim();
		if (!value || /[\r\n\u0000-\u001f\u007f]/.test(value)) continue;
		entries.set(pair[1], value);
	}
	if (!entries.has('__pus') && !entries.has('__puus')) return undefined;
	return Array.from(entries, ([name, value]) => `${name}=${value}`).join('; ');
}

function createRequestId(): string {
	const cryptoApi = globalThis.crypto;
	if (typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
	const bytes = new Uint8Array(16);
	cryptoApi.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
