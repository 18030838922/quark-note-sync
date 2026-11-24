const COOKIE_API_HOSTS = new Set(['drive-pc.quark.cn', 'drive.quark.cn', 'pan.quark.cn']);

export type QuarkHostKind = 'authenticated-api' | 'quark-transfer';
export type ResponseKind = 'text' | 'arraybuffer';
export type RequestPurpose = 'api' | 'download' | 'upload' | 'login';

export interface HttpRequest {
	url: string;
	method: string;
	cookie?: string;
	headers?: Record<string, string>;
	body?: string | Uint8Array;
	responseKind?: ResponseKind;
	purpose?: RequestPurpose;
}

export interface HttpResponse {
	status: number;
	headers: Record<string, string>;
	url: string;
	data: Uint8Array;
	text(): string;
}

export class QuarkTransportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'QuarkTransportError';
	}
}

export function classifyQuarkUrl(input: string, purpose: RequestPurpose = 'api'): QuarkHostKind | 'quark-download' | 'oss-upload' | 'quark-login' {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new QuarkTransportError('夸克请求 URL 无效');
	}
	if (url.protocol !== 'https:') throw new QuarkTransportError('夸克请求必须使用 HTTPS');
	if (url.username || url.password || url.port || url.hostname.endsWith('.')) {
		throw new QuarkTransportError('夸克请求主机不在允许列表');
	}
	if (purpose === 'api') {
		if (COOKIE_API_HOSTS.has(url.hostname)) return 'authenticated-api';
	} else if (purpose === 'login') {
		if (url.hostname === 'uop.quark.cn' && [
			'/cas/ajax/getTokenForQrcodeLogin',
			'/cas/ajax/getServiceTicketByQrcodeToken',
		].includes(url.pathname)) return 'quark-login';
		if (url.hostname === 'pan.quark.cn' && url.pathname === '/account/info') return 'quark-login';
	} else if (purpose === 'download') {
		if (COOKIE_API_HOSTS.has(url.hostname)) return 'authenticated-api';
		if (url.hostname.endsWith('.pds.quark.cn')) return 'quark-download';
	} else {
		if (url.hostname.endsWith('.pds.quark.cn') || url.hostname.endsWith('.aliyuncs.com')) return 'oss-upload';
	}
	throw new QuarkTransportError('夸克请求主机不在允许列表');
}

export function createSafeHeaders(
	url: string,
	cookie?: string,
	extra: Record<string, string> = {},
	purpose: RequestPurpose = 'api',
): Record<string, string> {
	const kind = classifyQuarkUrl(url, purpose);
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(extra)) {
		if (name.toLowerCase() !== 'cookie') headers[name] = value;
	}
	if ((kind === 'authenticated-api' || kind === 'quark-download') && cookie && purpose !== 'upload' && purpose !== 'login') {
		if (/[\r\n]/.test(cookie)) throw new QuarkTransportError('Cookie 格式无效');
		headers.Cookie = cookie;
	}
	return headers;
}

export function assertNoRedirect(status: number, _location?: string): void {
	if (status >= 300 && status < 400) {
		throw new QuarkTransportError('夸克服务器返回重定向，已停止请求，未转发 Cookie');
	}
}

export class QuarkTransport {
	private readonly isMobile: boolean;

	constructor(isMobile: boolean) {
		this.isMobile = isMobile;
	}

	async request(request: HttpRequest): Promise<HttpResponse> {
		if (request.purpose === 'login' && request.method !== 'GET') {
			throw new QuarkTransportError('夸克网页登录只允许固定的 GET 请求');
		}
		classifyQuarkUrl(request.url, request.purpose);
		const headers = createSafeHeaders(request.url, request.cookie, request.headers, request.purpose);
		const response = this.isMobile
			? await this.requestWithCapacitor(request, headers)
			: await this.requestWithNodeHttps(request, headers);
		assertNoRedirect(response.status, response.headers.location);
		if (response.url && response.url !== request.url) {
			throw new QuarkTransportError('请求地址发生变化，已停止处理响应');
		}
		return response;
	}

	private async requestWithCapacitor(
		request: HttpRequest,
		headers: Record<string, string>,
	): Promise<HttpResponse> {
		const bridge = (window as unknown as {
			Capacitor?: {
				isNativePlatform?: () => boolean;
				Plugins?: { CapacitorHttp?: { request: (options: Record<string, unknown>) => Promise<Record<string, unknown>> } };
			};
		}).Capacitor;
		const http = bridge?.Plugins?.CapacitorHttp;
		if (bridge?.isNativePlatform?.() !== true || !http?.request) {
			throw new QuarkTransportError('当前 Obsidian 移动端未提供可关闭重定向的 HTTPS 接口，请升级 Obsidian 后重试');
		}
		const data = request.body instanceof Uint8Array ? bytesToBase64(request.body) : request.body;
		const response = await http.request({
			url: request.url,
			method: request.method,
			headers,
			data,
			dataType: request.body instanceof Uint8Array ? 'file' : undefined,
			responseType: request.responseKind === 'arraybuffer' ? 'arraybuffer' : 'text',
			disableRedirects: true,
			connectTimeout: 30000,
			readTimeout: 60000,
		});
		const responseHeaders = normalizeHeaders(response.headers);
		const responseUrl = typeof response.url === 'string' ? response.url : request.url;
		const contentType = responseHeaders['content-type'] ?? '';
		const bytes = normalizeNativeBody(response.data, request.responseKind ?? 'text', contentType);
		return makeResponse(Number(response.status ?? 0), responseHeaders, responseUrl, bytes);
	}

	private async requestWithNodeHttps(
		request: HttpRequest,
		headers: Record<string, string>,
	): Promise<HttpResponse> {
		const nodeRequire = getNodeRequire();
		if (!nodeRequire) throw new QuarkTransportError('桌面 HTTPS 接口不可用');
		const https = nodeRequire('node:https');
		const url = new URL(request.url);
		const body = request.body instanceof Uint8Array ? request.body : request.body ? new TextEncoder().encode(request.body) : undefined;
		if (body) headers['Content-Length'] = String(body.byteLength);
		return await new Promise<HttpResponse>((resolve, reject) => {
			const outbound = https.request({
				protocol: 'https:',
				hostname: url.hostname,
				port: 443,
				path: `${url.pathname}${url.search}`,
				method: request.method,
				headers,
				timeout: 60000,
			}, (incoming: any) => {
				const chunks: Uint8Array[] = [];
				incoming.on('data', (chunk: Uint8Array | string) => {
					chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
				});
				incoming.on('end', () => {
					const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
					const data = new Uint8Array(length);
					let offset = 0;
					for (const chunk of chunks) {
						data.set(chunk, offset);
						offset += chunk.byteLength;
					}
					resolve(makeResponse(incoming.statusCode ?? 0, normalizeHeaders(incoming.headers), request.url, data));
				});
				incoming.on('error', reject);
			});
			outbound.on('timeout', () => outbound.destroy(new QuarkTransportError('夸克请求超时')));
			outbound.on('error', reject);
			if (body) outbound.write(body);
			outbound.end();
		});
	}
}

export function normalizeNativeBody(input: unknown, responseKind: ResponseKind, contentType: string): Uint8Array {
	if (input instanceof ArrayBuffer) return new Uint8Array(input);
	if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
	if (Array.isArray(input)) return new Uint8Array(input.map(Number));
	if (responseKind === 'arraybuffer' && typeof input === 'string' && !contentType.toLowerCase().includes('application/json')) {
		try {
			const binary = atob(input);
			const bytes = new Uint8Array(binary.length);
			for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
			return bytes;
		} catch {
			return new TextEncoder().encode(input);
		}
	}
	if (typeof input === 'string') return new TextEncoder().encode(input);
	if (input && typeof input === 'object') return new TextEncoder().encode(JSON.stringify(input) ?? '');
	return new Uint8Array();
}

function makeResponse(status: number, headers: Record<string, string>, url: string, data: Uint8Array): HttpResponse {
	return {
		status,
		headers,
		url,
		data,
		text: () => new TextDecoder().decode(data),
	};
}

function normalizeHeaders(input: unknown): Record<string, string> {
	if (!input || typeof input !== 'object') return {};
	return Object.fromEntries(
		Object.entries(input as Record<string, unknown>).map(([key, value]) => [
			key.toLowerCase(),
			Array.isArray(value) ? value.join(key.toLowerCase() === 'set-cookie' ? '\n' : ', ') : String(value),
		]),
	);
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	const chunkSize = 0x8000;
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
	}
	return btoa(binary);
}

function getNodeRequire(): ((name: string) => any) | undefined {
	try {
		return (window as unknown as { require?: (name: string) => any }).require ??
			(globalThis as unknown as { require?: (name: string) => any }).require ??
			(typeof require === 'function' ? require : undefined);
	} catch {
		return undefined;
	}
}

declare const require: ((name: string) => any) | undefined;
