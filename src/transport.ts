
const COOKIE_API_HOSTS = new Set(['drive-pc.quark.cn', 'drive.quark.cn', 'pan.quark.cn']);

export type QuarkHostKind = 'authenticated-api' | 'quark-transfer';
export type ResponseKind = 'text' | 'arraybuffer';
export type RequestPurpose = 'api' | 'download' | 'upload' | 'login' | 'share-api' | 'share-preview' | 'image-preview' | 'video-stream' | 'private-video-stream';

export interface HttpRequest {
	url: string;
	method: string;
	cookie?: string;
	headers?: Record<string, string>;
	body?: string | Uint8Array;
	responseKind?: ResponseKind;
	purpose?: RequestPurpose;
	maxResponseBytes?: number;
	onDownloadProgress?: (receivedBytes: number) => void;
	signal?: AbortSignal;
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

export function classifyQuarkUrl(
	input: string,
	purpose: RequestPurpose = 'api',
): QuarkHostKind | 'quark-download' | 'oss-upload' | 'quark-login' | 'quark-signed-download' | 'quark-video-stream' | 'quark-share-api' | 'quark-share-preview' {
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
		if (/^dl-(?:[a-z0-9]+-){1,4}[a-z0-9]+\.drive\.quark\.cn$/.test(url.hostname)) return 'quark-signed-download';
		throw new QuarkTransportError(`夸克下载主机不在允许列表（${url.hostname}）`);
	} else if (purpose === 'share-api') {
		if (url.hostname === 'pan.quark.cn' && [
			'/1/clouddrive/share/sharepage/token',
			'/1/clouddrive/share/sharepage/detail',
			'/1/clouddrive/share/sharepage/preview',
			'/1/clouddrive/share/sharepage/pdf_preview',
			'/1/clouddrive/share/sharepage/video_preview',
		].includes(url.pathname)) return 'quark-share-api';
	} else if (purpose === 'private-video-stream') {
		if (/^video-h-fkad-[a-z0-9]{2,8}\.drive\.quark\.cn$/.test(url.hostname)) return 'quark-video-stream';
	} else if (purpose === 'video-stream') {
		if (/^video-play(?:-[a-z0-9]+){1,8}\.drive\.quark\.cn$/.test(url.hostname) ||
			/^video-h-fkad-[a-z0-9]{2,8}\.drive\.quark\.cn$/.test(url.hostname)) return 'quark-video-stream';
	} else if (purpose === 'image-preview') {
		if (/^img-view-[a-z0-9]+(?:-[a-z0-9]+){1,3}\.drive\.quark\.cn$/.test(url.hostname)) return 'quark-share-preview';
	} else if (purpose === 'share-preview') {
		if ([
			'img-view-c-zb.drive.quark.cn',
			'img-view-c-sz.drive.quark.cn',
			'dl-c-sz-u.drive.quark.cn',
		].includes(url.hostname)) return 'quark-share-preview';
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
	if ((kind === 'authenticated-api' || kind === 'quark-download' || (kind === 'quark-video-stream' && purpose === 'private-video-stream')) && cookie && purpose !== 'upload' && purpose !== 'login') {
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

type TransportPlatform = 'desktop' | 'ios' | 'android' | 'mobile';

export class QuarkTransport {
	constructor(private readonly platform: TransportPlatform) {}

	async request(request: HttpRequest): Promise<HttpResponse> {
		if (request.purpose === 'login' && request.method !== 'GET') {
			throw new QuarkTransportError('夸克网页登录只允许固定的 GET 请求');
		}
		classifyQuarkUrl(request.url, request.purpose);
		if (request.purpose === 'share-api') assertShareApiMethod(request.url, request.method);
		if ((request.purpose === 'share-preview' || request.purpose === 'image-preview' || request.purpose === 'video-stream' || request.purpose === 'private-video-stream') && request.method !== 'GET') {
			throw new QuarkTransportError('夸克分享预览只允许固定的 GET 请求');
		}
		const maxResponseBytes = validateMaxResponseBytes(request.maxResponseBytes);
		const headers = createSafeHeaders(request.url, request.cookie, request.headers, request.purpose);
		const response = this.platform !== 'desktop'
			? await this.requestWithCapacitor(request, headers, maxResponseBytes)
			: await this.requestWithNodeHttps(request, headers, maxResponseBytes);
		assertNoRedirect(response.status, response.headers.location);
		if (response.url && response.url !== request.url) {
			throw new QuarkTransportError('请求地址发生变化，已停止处理响应');
		}
		return response;
	}

	private async requestWithCapacitor(
		request: HttpRequest,
		headers: Record<string, string>,
		maxResponseBytes?: number,
	): Promise<HttpResponse> {
		const bridge = (window as Window & {
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
		const status = Number(response.status ?? 0);
		assertDeclaredLengthWithinLimit(responseHeaders, maxResponseBytes);
		// iOS applies responseType to error bodies too. Android returns errors as text or JSON.
		const useRequestedKind = this.platform === 'ios' || (status >= 200 && status < 300);
		const responseKind = useRequestedKind ? request.responseKind ?? 'text' : 'text';
		const bytes = normalizeNativeBody(response.data, responseKind, contentType);
		assertResponseLengthWithinLimit(bytes, maxResponseBytes);
		if (status === 200) request.onDownloadProgress?.(bytes.byteLength);
		return makeResponse(status, responseHeaders, responseUrl, bytes);
	}

	private async requestWithNodeHttps(
		request: HttpRequest,
		headers: Record<string, string>,
		maxResponseBytes?: number,
	): Promise<HttpResponse> {
		const nodeRequire = this.platform === 'desktop' ? getNodeRequire() : undefined;
		if (!nodeRequire) throw new QuarkTransportError('桌面 HTTPS 接口不可用');
		const https = nodeRequire('node:https');
		const url = new URL(request.url);
		const body = request.body instanceof Uint8Array ? request.body : request.body ? new TextEncoder().encode(request.body) : undefined;
		if (body) headers['Content-Length'] = String(body.byteLength);
		return await new Promise<HttpResponse>((resolve, reject) => {
			let settled = false;
			const fail = (error: Error): void => {
				if (settled) return;
				settled = true;
				reject(error);
			};
			const outbound = https.request({
				protocol: 'https:',
				hostname: url.hostname,
				port: 443,
				path: `${url.pathname}${url.search}`,
				method: request.method,
				headers,
				timeout: 60000,
				signal: request.signal,
			}, (incoming) => {
				try {
					assertDeclaredLengthWithinLimit(normalizeHeaders(incoming.headers), maxResponseBytes);
				} catch (error) {
					fail(error instanceof Error ? error : new QuarkTransportError('夸克响应超过安全大小限制'));
					incoming.destroy();
					outbound.destroy();
					return;
				}
				const chunks: Uint8Array[] = [];
				let receivedBytes = 0;
				incoming.on('data', (chunk: Uint8Array | string) => {
					if (settled) return;
					const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
					if (maxResponseBytes !== undefined && receivedBytes + bytes.byteLength > maxResponseBytes) {
						fail(new QuarkTransportError('夸克响应超过安全大小限制'));
						incoming.destroy();
						outbound.destroy();
						return;
					}
					receivedBytes += bytes.byteLength;
					if (incoming.statusCode === 200) request.onDownloadProgress?.(receivedBytes);
					chunks.push(bytes);
				});
				incoming.on('end', () => {
					if (settled) return;
					const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
					const data = new Uint8Array(length);
					let offset = 0;
					for (const chunk of chunks) {
						data.set(chunk, offset);
						offset += chunk.byteLength;
					}
					settled = true;
					resolve(makeResponse(incoming.statusCode ?? 0, normalizeHeaders(incoming.headers), request.url, data));
				});
				incoming.on('error', fail);
			});
			outbound.on('timeout', () => outbound.destroy(new QuarkTransportError('夸克请求超时')));
			outbound.on('error', fail);
			if (body) outbound.write(body);
			outbound.end();
		});
	}
}

function assertShareApiMethod(input: string, method: string): void {
	const url = new URL(input);
	const expectedMethod: Record<string, string> = {
		'/1/clouddrive/share/sharepage/token': 'POST',
		'/1/clouddrive/share/sharepage/detail': 'GET',
		'/1/clouddrive/share/sharepage/preview': 'GET',
		'/1/clouddrive/share/sharepage/pdf_preview': 'GET',
		'/1/clouddrive/share/sharepage/video_preview': 'GET',
	};
	if (expectedMethod[url.pathname] !== method) {
		throw new QuarkTransportError('夸克分享接口只允许已验证的固定请求方式');
	}
}

function validateMaxResponseBytes(input: number | undefined): number | undefined {
	if (input === undefined) return undefined;
	if (!Number.isSafeInteger(input) || input <= 0) throw new QuarkTransportError('夸克响应大小限制无效');
	return input;
}

function assertDeclaredLengthWithinLimit(headers: Record<string, string>, limit?: number): void {
	if (limit === undefined) return;
	const value = headers['content-length'];
	if (value === undefined) return;
	const length = Number(value);
	if (!Number.isSafeInteger(length) || length < 0) throw new QuarkTransportError('夸克响应长度无效');
	if (length > limit) throw new QuarkTransportError('夸克响应超过安全大小限制');
}

function assertResponseLengthWithinLimit(data: Uint8Array, limit?: number): void {
	if (limit !== undefined && data.byteLength > limit) throw new QuarkTransportError('夸克响应超过安全大小限制');
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

interface DesktopHttpsResponse {
	headers: unknown;
	statusCode?: number;
	destroy(): void;
	on(event: 'data', listener: (chunk: Uint8Array | string) => void): void;
	on(event: 'error', listener: (error: Error) => void): void;
	on(event: 'end', listener: () => void): void;
}

interface DesktopHttpsRequest {
	destroy(error?: Error): void;
	on(event: 'timeout', listener: () => void): void;
	on(event: 'error', listener: (error: Error) => void): void;
	write(body: Uint8Array): void;
	end(): void;
}

type HttpsRequire = (name: 'node:https') => {
	request(options: {
		protocol: 'https:';
		hostname: string;
		port: number;
		path: string;
		method: string;
		headers: Record<string, string>;
		timeout: number;
		signal?: AbortSignal;
	}, onResponse: (incoming: DesktopHttpsResponse) => void): DesktopHttpsRequest;
};

function getNodeRequire(): HttpsRequire | undefined {
	try {
		const desktopWindow = window as Window & { require?: HttpsRequire };
		return desktopWindow.require ?? (typeof require === 'function' ? require : undefined);
	} catch {
		return undefined;
	}
}

declare const require: HttpsRequire | undefined;
