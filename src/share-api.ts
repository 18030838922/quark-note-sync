import type { HttpRequester } from './quark-api.ts';
import type { HttpRequest, HttpResponse } from './transport.ts';
import { classifyQuarkUrl } from './transport.ts';

const SHARE_ORIGIN = 'https://pan.quark.cn';
const SHARE_API = `${SHARE_ORIGIN}/1/clouddrive/share/sharepage`;
const PAGE_SIZE = 50;
const MAX_PAGES = 1000;
const MAX_PREVIEW_BYTES = 20 * 1024 * 1024;

export interface ShareSession {
	readonly pwdId: string;
	readonly stoken: string;
}

export interface ShareEntry {
	readonly fid: string;
	readonly name: string;
	readonly isDirectory: boolean;
	readonly size: number;
	/** Short-lived per-file share token. Keep it in memory and never persist it. */
	readonly fidToken: string;
}

export type ShareApiErrorReason = 'passcode' | 'missing' | 'expired' | 'unsupported' | 'request';

const ERROR_MESSAGES: Record<ShareApiErrorReason, string> = {
	passcode: '夸克分享密码无效或尚未输入',
	missing: '夸克分享链接无效或已失效',
	expired: '夸克分享链接已过期',
	unsupported: '此分享文件暂不支持安全预览或下载',
	request: '夸克分享请求失败，请稍后重试',
};

export class ShareApiError extends Error {
	readonly reason: ShareApiErrorReason;
	readonly httpStatus?: number;

	constructor(reason: ShareApiErrorReason, httpStatus?: number) {
		super(ERROR_MESSAGES[reason]);
		this.name = 'ShareApiError';
		this.reason = reason;
		if (httpStatus !== undefined) this.httpStatus = httpStatus;
	}
}

export interface ShareBytes {
	readonly bytes: Uint8Array;
	readonly mimeType: string;
}

interface ApiBody {
	readonly code?: unknown;
	readonly status?: unknown;
	readonly data?: unknown;
	readonly metadata?: unknown;
	readonly [key: string]: unknown;
}

export class QuarkShareClient {
	private readonly transport: HttpRequester;

	constructor(transport: HttpRequester) {
		this.transport = transport;
	}

	async openShare(pwdId: string, passcode: string): Promise<ShareSession> {
		const normalizedPwdId = safeInput(pwdId, 'missing');
		const normalizedPasscode = safePasscode(passcode);
		const body = await this.requestJson(`${SHARE_API}/token`, 'POST', {}, {
			pwd_id: normalizedPwdId,
			passcode: normalizedPasscode,
		});
		const data = asRecord(body.data);
		const stoken = readString(data.stoken);
		if (!stoken) throw new ShareApiError('request');
		return { pwdId: normalizedPwdId, stoken };
	}

	async listDirectory(session: ShareSession, pdirFid: string): Promise<ShareEntry[]> {
		const validSession = requireSession(session);
		const parentFid = safeInput(pdirFid, 'request');
		const entries: ShareEntry[] = [];
		const seen = new Set<string>();
		let expectedTotal: number | undefined;

		for (let page = 1; page <= MAX_PAGES; page += 1) {
			const body = await this.requestJson(`${SHARE_API}/detail`, 'GET', {
				pwd_id: validSession.pwdId,
				stoken: validSession.stoken,
				pdir_fid: parentFid,
				_page: String(page),
				_size: String(PAGE_SIZE),
				_fetch_total: '1',
			});
			const data = asRecord(body.data);
			const list = data.list;
			const total = readTotal(body, data);
			if (!Array.isArray(list) || total === undefined || list.length > PAGE_SIZE) {
				throw new ShareApiError('request');
			}
			if (expectedTotal === undefined) expectedTotal = total;
			else if (expectedTotal !== total) throw new ShareApiError('request');
			if (entries.length + list.length > total) throw new ShareApiError('request');

			for (const value of list) {
				const entry = normalizeShareEntry(value);
				if (seen.has(entry.fid)) throw new ShareApiError('request');
				seen.add(entry.fid);
				entries.push(entry);
			}

			if (entries.length === total) return entries;
			if (list.length === 0) throw new ShareApiError('request');
		}
		throw new ShareApiError('request');
	}

	async previewDocumentOrImage(session: ShareSession, entry: ShareEntry): Promise<ShareBytes> {
		const validSession = requireSession(session);
		const validEntry = requireFileEntry(entry);
		if (isPdf(validEntry.name)) {
			const url = await this.getPdfPreviewUrl(validSession, validEntry);
			return await this.fetchPayload(url, MAX_PREVIEW_BYTES, 'pdf');
		}
		if (!isRasterImage(validEntry.name)) throw new ShareApiError('unsupported');

		const url = new URL(`${SHARE_API}/preview`);
		url.searchParams.set('pr', 'ucpro');
		url.searchParams.set('fr', 'pc');
		url.searchParams.set('pwd_id', validSession.pwdId);
		url.searchParams.set('stoken', validSession.stoken);
		url.searchParams.set('fid_list', validEntry.fid);
		url.searchParams.set('fid_token_list', validEntry.fidToken);
		url.searchParams.set('format', 'png');
		const body = await this.requestJson(url.toString(), 'GET');
		const item = findMatchingItem(body.data, validEntry.fid);
		const previewUrl = readString(item.preview_url);
		if (!previewUrl) throw new ShareApiError('unsupported');
		return await this.fetchPayload(previewUrl, MAX_PREVIEW_BYTES, 'raster');
	}

	async downloadFile(session: ShareSession, entry: ShareEntry, maxBytes: number): Promise<ShareBytes> {
		const validSession = requireSession(session);
		const validEntry = requireFileEntry(entry);
		if (!isPdf(validEntry.name)) throw new ShareApiError('unsupported');
		if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || validEntry.size > maxBytes) {
			throw new ShareApiError('unsupported');
		}
		const url = await this.getPdfPreviewUrl(validSession, validEntry);
		return await this.fetchPayload(url, maxBytes, 'pdf', validEntry.size);
	}

	private async getPdfPreviewUrl(session: ShareSession, entry: ShareEntry): Promise<string> {
		const url = new URL(`${SHARE_API}/pdf_preview`);
		url.searchParams.set('pr', 'ucpro');
		url.searchParams.set('fr', 'pc');
		url.searchParams.set('pwd_id', session.pwdId);
		url.searchParams.set('stoken', session.stoken);
		url.searchParams.set('fid', entry.fid);
		url.searchParams.set('fid_token', entry.fidToken);
		url.searchParams.set('fid_list', entry.fid);
		url.searchParams.set('fid_token_list', entry.fidToken);
		url.searchParams.set('format', 'png');
		const body = await this.requestJson(url.toString(), 'GET');
		const item = findMatchingItem(body.data, entry.fid, true);
		const downloadUrl = readString(item.download_url);
		if (!downloadUrl) throw new ShareApiError('unsupported');
		return validatePreviewUrl(downloadUrl);
	}

	private async fetchPayload(url: string, maxBytes: number, expected: 'pdf' | 'raster', exactSize?: number): Promise<ShareBytes> {
		let response: HttpResponse;
		try {
			response = await this.transport.request({
				url,
				method: 'GET',
				purpose: 'share-preview',
				responseKind: 'arraybuffer',
				maxResponseBytes: maxBytes,
			});
		} catch {
			throw new ShareApiError('request');
		}
		if ((response.status >= 300 && response.status < 400) || (response.url && response.url !== url)) {
			throw new ShareApiError('request', response.status);
		}
		if (response.status < 200 || response.status >= 300) throw new ShareApiError('request', response.status);
		const bytes = response.data;
		if (bytes.byteLength > maxBytes || (exactSize !== undefined && bytes.byteLength !== exactSize)) {
			throw new ShareApiError('unsupported');
		}
		const declaredLength = response.headers['content-length'];
		if (declaredLength !== undefined) {
			const length = Number(declaredLength);
			if (!Number.isSafeInteger(length) || length !== bytes.byteLength) throw new ShareApiError('unsupported');
		}
		const declaredMime = (response.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
		if (declaredMime === 'text/html' || declaredMime === 'application/xhtml+xml') throw new ShareApiError('unsupported');
		const mimeType = sniffPayloadMime(bytes);
		if (!mimeType || (expected === 'pdf' && mimeType !== 'application/pdf') || (expected === 'raster' && !mimeType.startsWith('image/'))) {
			throw new ShareApiError('unsupported');
		}
		if (declaredMime && declaredMime !== mimeType && declaredMime !== 'application/octet-stream') {
			throw new ShareApiError('unsupported');
		}
		return { bytes, mimeType };
	}

	private async requestJson(
		input: string,
		method: 'GET' | 'POST',
		query: Record<string, string> = {},
		body?: Record<string, unknown>,
	): Promise<ApiBody> {
		const url = new URL(input);
		for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
		url.searchParams.set('pr', 'ucpro');
		url.searchParams.set('fr', 'pc');
		let response: HttpResponse;
		const request: HttpRequest = {
			url: url.toString(),
			method,
			purpose: 'share-api',
			...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}),
		};
		try {
			response = await this.transport.request(request);
		} catch {
			throw new ShareApiError('request');
		}
		if ((response.status >= 300 && response.status < 400) || (response.url && response.url !== request.url)) {
			throw new ShareApiError('request', response.status);
		}
		let parsed: ApiBody;
		try {
			const value: unknown = JSON.parse(response.text());
			parsed = asRecord(value);
		} catch {
			throw new ShareApiError('request', response.status);
		}
		const reason = mapBusinessFailure(parsed);
		if (reason) throw new ShareApiError(reason, response.status);
		if (response.status < 200 || response.status >= 300 || !isSuccessCode(parsed.code)) {
			throw new ShareApiError('request', response.status);
		}
		return parsed;
	}
}

function safeInput(value: string, reason: ShareApiErrorReason): string {
	if (typeof value !== 'string') throw new ShareApiError(reason);
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > 512 || /[\u0000-\u001f\u007f]/.test(trimmed)) throw new ShareApiError(reason);
	return trimmed;
}

function safePasscode(value: string): string {
	if (typeof value !== 'string') throw new ShareApiError('passcode');
	const trimmed = value.trim();
	if (trimmed.length > 512 || /[\u0000-\u001f\u007f]/.test(trimmed)) throw new ShareApiError('passcode');
	return trimmed;
}

function requireSession(value: ShareSession): ShareSession {
	if (!value || typeof value !== 'object') throw new ShareApiError('request');
	return {
		pwdId: safeInput(value.pwdId, 'request'),
		stoken: safeInput(value.stoken, 'request'),
	};
}

function requireFileEntry(value: ShareEntry): ShareEntry {
	if (!value || typeof value !== 'object' || value.isDirectory !== false) throw new ShareApiError('unsupported');
	if (!Number.isSafeInteger(value.size) || value.size < 0) throw new ShareApiError('unsupported');
	return {
		fid: safeInput(value.fid, 'unsupported'),
		name: safeInput(value.name, 'unsupported'),
		isDirectory: false,
		size: value.size,
		fidToken: safeInput(value.fidToken, 'unsupported'),
	};
}

function normalizeShareEntry(value: unknown): ShareEntry {
	const row = asRecord(value);
	const fid = readIdentifier(row.fid);
	const name = readString(row.file_name);
	const fidToken = readString(row.share_fid_token);
	const size = readNonNegativeInteger(row.size);
	const isDirectory = readDirectoryFlag(row.dir);
	if (!fid || !name || !fidToken || size === undefined || isDirectory === undefined) throw new ShareApiError('request');
	return { fid, name, isDirectory, size, fidToken };
}

function readTotal(body: ApiBody, data: Record<string, unknown>): number | undefined {
	const metadata = asRecord(body.metadata);
	const nestedMetadata = asRecord(data.metadata);
	return readNonNegativeInteger(metadata._total ?? nestedMetadata._total);
}

function readDirectoryFlag(value: unknown): boolean | undefined {
	if (value === true || value === 1 || value === '1') return true;
	if (value === false || value === 0 || value === '0') return false;
	return undefined;
}

function readNonNegativeInteger(value: unknown): number | undefined {
	const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
	return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function readIdentifier(value: unknown): string | undefined {
	if (typeof value === 'string' && value.trim()) return value;
	if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
	return undefined;
}

function readString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isSuccessCode(value: unknown): boolean {
	return value === undefined || value === null || value === 0 || value === '0' || value === 'OK' || value === 200 || value === '200';
}

function mapBusinessFailure(body: ApiBody): ShareApiErrorReason | undefined {
	const values = [body.code, body.status].map((value) => typeof value === 'string' || typeof value === 'number' ? String(value) : '');
	if (values.includes('41008')) return 'passcode';
	if (values.includes('41006')) return 'missing';
	if (values.includes('41019')) return 'expired';
	return undefined;
}

function findMatchingItem(value: unknown, fid: string, allowSingleUnmatched = false): Record<string, unknown> {
	const values = Array.isArray(value) ? value : [value];
	for (const candidate of values) {
		const item = asRecord(candidate);
		if (readIdentifier(item.fid) === fid) return item;
	}
	if (allowSingleUnmatched && !Array.isArray(value) && values.length === 1) {
		const item = asRecord(values[0]);
		if (item.download_url !== undefined) return item;
	}
	throw new ShareApiError('unsupported');
}

function validatePreviewUrl(value: string): string {
	try {
		classifyQuarkUrl(value, 'share-preview');
		return value;
	} catch {
		throw new ShareApiError('unsupported');
	}
}

function isPdf(name: string): boolean {
	return /\.pdf$/i.test(name);
}

function isRasterImage(name: string): boolean {
	return /\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif)$/i.test(name);
}

function sniffPayloadMime(bytes: Uint8Array): string | undefined {
	if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
	if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
	if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return 'image/gif';
	if (startsWith(bytes, [0x42, 0x4d])) return 'image/bmp';
	if (bytes.length >= 12 && startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && ascii(bytes.subarray(8, 12)) === 'WEBP') return 'image/webp';
	if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return 'image/tiff';
	return undefined;
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
	return bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array): string {
	return String.fromCharCode(...bytes);
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
