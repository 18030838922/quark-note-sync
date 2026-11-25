import { selectQuarkVideoStream } from './video-stream-url.ts';
import { sniffPayloadMime } from './share-api.ts';
import { hasAsciiControl } from './core.ts';
import { md5Base64, md5Hex, sha1Hex } from './hash.ts';
import type { HttpRequest, HttpResponse } from './transport';
import { classifyQuarkUrl, QuarkTransportError } from './transport.ts';

const DRIVE_ORIGIN = 'https://drive-pc.quark.cn';
const DRIVE_API = `${DRIVE_ORIGIN}/1/clouddrive`;
const PAGE_SIZE = 50;
const MAX_PAGES = 10000;
const OSS_USER_AGENT = 'aliyun-sdk-js/6.6.1';
const QUARK_WEB_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface HttpRequester {
	request(request: HttpRequest): Promise<HttpResponse>;
}

export interface RemoteFile {
	parentFid?: string;
	updatedAt?: number;
	imagePreviewUrls?: string[];
	fid: string;
	name: string;
	isDirectory: boolean;
	size: number;
}

export interface StorageQuota {
	totalBytes: number;
	usedBytes: number;
}

export class QuarkAuthenticationError extends Error {
	readonly status: number;

	constructor(status: number) {
		super('夸克 Cookie 无效或已过期，请在此设备更新 Cookie');
		this.name = 'QuarkAuthenticationError';
		this.status = status;
	}
}

interface ApiEnvelope {
	code?: number | string;
	message?: string;
	msg?: string;
	data?: Record<string, unknown> | unknown[];
	[key: string]: unknown;
}

export class QuarkClient {
	private readonly transport: HttpRequester;
	private cookie: string;

	constructor(transport: HttpRequester, cookie: string) {
		this.transport = transport;
		this.cookie = cookie;
	}

	get sessionCookie(): string {
		return this.cookie;
	}

	async checkConnection(): Promise<string | undefined> {
		return (await this.checkAccount()).accountId;
	}

	async checkAccount(): Promise<{ accountId?: string; nickname?: string }> {
		const url = new URL('https://pan.quark.cn/account/info');
		url.searchParams.set('fr', 'pc');
		url.searchParams.set('platform', 'pc');
		const accountInfo = await this.requestApi(url.toString(), 'GET');
		const drive = asRecord(await this.requestApi(`${DRIVE_API}/file/sort`, 'GET', {
			pdir_fid: '0',
			_page: '1',
			_size: '1',
			_fetch_total: '1',
			_fetch_sub_dirs: '0',
		}));
		if (!Array.isArray(drive.list)) throw new Error('Cookie 已登录，但夸克目录读取失败');
		const accountId = readAccountId(accountInfo) ?? readCookieValue(this.cookie, '__uid');
		const nickname = readAccountNickname(accountInfo);
		return {
			...(accountId ? { accountId } : {}),
			...(nickname ? { nickname } : {}),
		};
	}

	async getStorageQuota(): Promise<StorageQuota | undefined> {
		let data: Record<string, unknown>;
		try {
			data = asRecord(await this.requestApi(`${DRIVE_API}/member`, 'GET'));
		} catch (error) {
			if (error instanceof QuarkAuthenticationError) throw error;
			return undefined;
		}
		const totalBytes = readNonNegativeNumber(data.total_capacity);
		const usedBytes = readNonNegativeNumber(data.use_capacity);
		if (totalBytes === undefined || usedBytes === undefined || usedBytes > totalBytes) return undefined;
		return { totalBytes, usedBytes };
	}

	async findRootFolder(name: string): Promise<RemoteFile | undefined> {
		return await this.findChildByName('0', name);
	}

	async getFileById(fid: string): Promise<RemoteFile> {
		if (!/^[\w-]{1,512}$/.test(fid)) throw new Error('夸克文件编号无效');
		const data = await this.requestApi(`${DRIVE_API}/file/v2/info/list`, 'POST', {}, {
			fids: [fid],
			fetch_pdir_name: 1,
			filter_secret_check_fail: 1,
		});
		const candidates: unknown = Array.isArray(data) ? data : asRecord(data).list;
		if (!Array.isArray(candidates)) throw new Error('夸克文件详情响应不完整');
		const match = candidates.find((value) => String(asRecord(value).fid ?? '') === fid);
		if (!match) throw new Error('夸克中未找到此文件，或当前账号无权访问');
		return normalizeRemoteFile(match);
	}

	async listDirectory(parentId: string): Promise<RemoteFile[]> {
		const files: RemoteFile[] = [];
		const seen = new Set<string>();
		let expectedTotal: number | undefined;
		for (let page = 1; page <= MAX_PAGES; page += 1) {
			const data = await this.requestApi(`${DRIVE_API}/file/sort`, 'GET', {
				pdir_fid: parentId,
				_page: String(page),
				_size: String(PAGE_SIZE),
				_sort: 'file_name:asc',
				_fetch_total: '1',
				_fetch_sub_dirs: '0',
			});
			const body = asRecord(data);
			const list = body.list;
			if (!Array.isArray(list)) throw new Error('夸克目录响应不完整，已暂停同步');
			const total = readTotal(body);
			if (total === undefined) throw new Error('夸克未返回总数，分页状态不完整，已暂停同步');
			if (expectedTotal === undefined) expectedTotal = total;
			else if (expectedTotal !== total) throw new Error('夸克目录在分页期间发生变化，已暂停同步');
			if (list.length > PAGE_SIZE || files.length + list.length > total) throw new Error('夸克分页数据不一致，已暂停同步');
			for (const value of list) {
				const file = normalizeRemoteFile(value);
				if (seen.has(file.fid)) throw new Error('夸克分页返回重复文件编号，已暂停同步');
				seen.add(file.fid);
				files.push(file);
			}
			if (files.length === total) return files;
			if (list.length === 0) throw new Error('夸克分页提前结束，已暂停同步');
		}
		throw new Error('夸克目录超过分页安全上限，已暂停同步');
	}

	async findChildByName(parentId: string, name: string): Promise<RemoteFile | undefined> {
		const matches = (await this.listDirectory(parentId)).filter((file) => file.name === name);
		if (matches.length > 1) throw new Error(`夸克目录中存在多个同名项目：${name}`);
		return matches[0];
	}

	async ensureFolder(parentId: string, name: string): Promise<string> {
		const existing = await this.findChildByName(parentId, name);
		if (existing) {
			if (!existing.isDirectory) throw new Error(`夸克中同名文件占用了目录名：${name}`);
			return existing.fid;
		}
		try {
			const data = await this.requestApi(`${DRIVE_API}/file`, 'POST', {}, {
				pdir_fid: parentId,
				file_name: name,
				dir_init_lock: false,
				dir_path: '',
			});
			const record = asRecord(data);
			const candidate = asRecord(record.file ?? record);
			const fid = candidate.fid ?? candidate.id;
			if (fid !== undefined && String(fid)) return String(fid);
		} catch (error) {
			const raced = await this.findChildByName(parentId, name).catch(() => undefined);
			if (raced?.isDirectory) return raced.fid;
			throw error;
		}
		const created = await this.findChildByName(parentId, name);
		if (created?.isDirectory) return created.fid;
		throw new Error(`夸克未确认目录创建成功：${name}`);
	}

	async uploadFile(parentId: string, name: string, content: Uint8Array): Promise<RemoteFile> {
		const existing = await this.findChildByName(parentId, name);
		if (existing) {
			if (existing.isDirectory || existing.size !== content.byteLength) throw new Error(`夸克中同名文件大小不符：${name}`);
			return existing;
		}
		const now = Date.now();
		const pre = asRecord(await this.requestApi(`${DRIVE_API}/file/upload/pre`, 'POST', {}, {
			ccp_hash_update: true,
			parallel_upload: false,
			same_path_reuse: true,
			pdir_fid: parentId,
			dir_name: '',
			size: content.byteLength,
			file_name: name,
			format_type: 'application/octet-stream',
			l_updated_at: now,
			l_created_at: now,
		}));
		const preFid = firstString(pre.fid, pre.file_id);
		if (isFinished(pre)) {
			return this.finalizeInstantUpload(
				parentId,
				name,
				content.byteLength,
				firstString(pre.task_id),
				firstString(pre.obj_key),
				preFid,
			);
		}
		const taskId = requiredString(pre.task_id, '夸克预上传缺少 task_id');
		const authInfo = requiredString(pre.auth_info, '夸克预上传缺少 auth_info');
		const hashReply = asRecord(await this.requestApi(`${DRIVE_API}/file/update/hash`, 'POST', {}, {
			task_id: taskId,
			md5: md5Hex(content),
			sha1: await sha1Hex(content),
		}));
		const hashFid = firstString(hashReply.fid, hashReply.file_id, hashReply.file);
		if (isFinished(hashReply)) {
			return this.finalizeInstantUpload(
				parentId,
				name,
				content.byteLength,
				firstString(hashReply.task_id, taskId),
				firstString(hashReply.obj_key, pre.obj_key),
				hashFid,
			);
		}
		const objKey = requiredString(pre.obj_key, '夸克预上传缺少 obj_key');
		const bucket = requiredString(pre.bucket, '夸克预上传缺少 bucket');
		const uploadId = requiredString(pre.upload_id, '夸克预上传缺少 upload_id');
		const uploadHost = buildUploadHost(bucket, String(pre.upload_url ?? 'pds.quark.cn'));
		const partSize = readPositiveNumber(
			asRecord(pre.metadata).part_size ?? pre.part_size ?? asRecord(pre.__envelope_metadata).part_size,
		) ?? 4 * 1024 * 1024;
		const totalParts = Math.max(1, Math.ceil(content.byteLength / partSize));
		const etags: string[] = [];
		for (let partNumber = 1; partNumber <= totalParts; partNumber += 1) {
			const start = (partNumber - 1) * partSize;
			const part = content.subarray(start, Math.min(start + partSize, content.byteLength));
			const partUrl = buildPartUrl(uploadHost, objKey, partNumber, uploadId);
			const date = new Date().toUTCString();
			const authMeta = [
				'PUT',
				'',
				'application/octet-stream',
				date,
				`x-oss-date:${date}`,
				`x-oss-user-agent:${OSS_USER_AGENT}`,
				`/${bucket}/${objKey}?partNumber=${partNumber}&uploadId=${uploadId}`,
			].join('\n');
			const auth = asRecord(await this.requestApi(`${DRIVE_API}/file/upload/auth`, 'POST', {}, {
				task_id: taskId,
				auth_info: authInfo,
				auth_meta: authMeta,
			}));
			const authorization = requiredString(auth.auth_key, '夸克上传授权响应缺少 auth_key');
			const uploaded = await this.transport.request({
				url: partUrl,
				method: 'PUT',
				purpose: 'upload',
				body: part,
				headers: {
					Authorization: authorization,
					'Content-Type': 'application/octet-stream',
					'Content-Length': String(part.byteLength),
					'Referer': 'https://pan.quark.cn/',
					'x-oss-date': date,
					'x-oss-user-agent': OSS_USER_AGENT,
				},
			});
			if (uploaded.status !== 200) throw new Error(`夸克对象存储上传失败（HTTP ${uploaded.status}）`);
			const etag = uploaded.headers.etag?.replace(/^"|"$/g, '');
			if (!etag || !/^[a-f\d]+$/i.test(etag)) throw new Error('夸克对象存储未返回有效 ETag');
			etags.push(etag);
		}

		const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<CompleteMultipartUpload>\n${etags.map((etag, index) => `<Part><PartNumber>${index + 1}</PartNumber><ETag>"${etag}"</ETag></Part>`).join('\n')}\n</CompleteMultipartUpload>`;
		const xmlBytes = new TextEncoder().encode(xml);
		const contentMd5 = md5Base64(xmlBytes);
		const callback = typeof pre.callback === 'string' ? pre.callback : JSON.stringify(pre.callback ?? {});
		const callback64 = utf8ToBase64(callback);
		const commitDate = new Date().toUTCString();
		const commitMeta = [
			'POST',
			contentMd5,
			'application/xml',
			commitDate,
			`x-oss-callback:${callback64}`,
			`x-oss-date:${commitDate}`,
			`x-oss-user-agent:${OSS_USER_AGENT}`,
			`/${bucket}/${objKey}?uploadId=${uploadId}`,
		].join('\n');
		const commitAuth = asRecord(await this.requestApi(`${DRIVE_API}/file/upload/auth`, 'POST', {}, {
			task_id: taskId,
			auth_info: authInfo,
			auth_meta: commitMeta,
		}));
		const commitKey = requiredString(commitAuth.auth_key, '夸克合并授权响应缺少 auth_key');
		const commit = await this.transport.request({
			url: `${uploadHost}/${encodeObjectKey(objKey)}?uploadId=${encodeURIComponent(uploadId)}`,
			method: 'POST',
			purpose: 'upload',
			body: xmlBytes,
			headers: {
				Authorization: commitKey,
				'Content-Type': 'application/xml',
				'Content-Length': String(xmlBytes.byteLength),
				'Content-MD5': contentMd5,
				'Referer': 'https://pan.quark.cn/',
				'x-oss-callback': callback64,
				'x-oss-date': commitDate,
				'x-oss-user-agent': OSS_USER_AGENT,
			},
		});
		if (![200, 203].includes(commit.status)) throw new Error(`夸克对象存储合并失败（HTTP ${commit.status}）`);
		await this.requestApi(`${DRIVE_API}/file/upload/finish`, 'POST', {}, { task_id: taskId, obj_key: objKey });
		return this.confirmUploaded(parentId, name, content.byteLength, preFid);
	}

	async getVideoStream(file: RemoteFile): Promise<string> {
		const data = await this.requestApi(`${DRIVE_API}/file/v2/play`, 'POST', {}, {
			fid: file.fid, resolutions: 'low', supports: 'fmp4,m3u8',
		});
		return selectQuarkVideoStream(data);
	}

	async requestVideoSegment(request: HttpRequest): Promise<HttpResponse> {
		let purpose: HttpRequest['purpose'] = 'private-video-stream';
		try {
			classifyQuarkUrl(request.url, purpose);
		} catch {
			purpose = 'video-stream';
		}
		return await this.transport.request({
			...request, purpose, cookie: purpose === 'private-video-stream' ? this.cookie : undefined,
			headers: {
				...request.headers,
				Origin: 'https://pan.quark.cn',
				Referer: 'https://pan.quark.cn/',
				'User-Agent': QUARK_WEB_USER_AGENT,
			},
		});
	}

	async previewImage(file: RemoteFile, maxBytes: number): Promise<{ bytes: Uint8Array; mimeType: string }> {
		const urls = new Set(file.imagePreviewUrls ?? []);
		if (file.parentFid && file.updatedAt !== undefined) {
			try {
				const data = await this.requestApi(`${DRIVE_API}/file/advanced_preview`, 'GET', {
					pdir_fid: file.parentFid, cat: 'image', _sort: 'updated_at:desc', _size: '15',
					cur_fid: file.fid, cur_value: String(file.updatedAt), direction: 'after',
				});
				const rows = Array.isArray(data) ? data : asRecord(data).list;
				if (Array.isArray(rows)) {
					const row = rows.map(asRecord).find((entry) => String(entry.fid) === file.fid);
					if (typeof row?.preview_url === 'string') urls.add(row.preview_url);
				}
			} catch (error) {
				if (error instanceof QuarkAuthenticationError) throw error;
			}
		}
		for (const url of [...urls].reverse()) {
			try {
				const response = await this.transport.request({
					url, method: 'GET', purpose: 'image-preview', responseKind: 'arraybuffer', maxResponseBytes: maxBytes,
				});
				const mimeType = sniffPayloadMime(response.data);
				if (response.status === 200 && response.data.byteLength <= maxBytes && mimeType?.startsWith('image/')) {
					return { bytes: response.data, mimeType };
				}
			} catch {
				// An expired or unsupported preview URL can fall back to the original.
			}
		}
		const bytes = await this.downloadFile(file, maxBytes);
		const mimeType = sniffPayloadMime(bytes);
		if (!mimeType?.startsWith('image/')) throw new Error('夸克返回的内容不是受支持的图片');
		return { bytes, mimeType };
	}

	async downloadFile(file: RemoteFile, maxBytes?: number): Promise<Uint8Array> {
		if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || file.size > maxBytes)) {
			throw new Error(`夸克文件超过预览上限：${file.name}`);
		}
		let response = await this.requestDownload(file, maxBytes);
		let failure = response.status === 403 ? readDownloadFailure(response.data) : undefined;
		if (response.status === 403 && (!failure || failure.retryable)) {
			response = await this.requestDownload(file, maxBytes);
			failure = response.status === 403 ? readDownloadFailure(response.data) : undefined;
		}
		if (response.status !== 200) {
			const reason = failure ? '，' + failure.label : response.status === 412 ? '，可在夸克网页或客户端中尝试下载原文件' : '';
			throw new Error(`夸克下载失败（HTTP ${response.status}${reason}）：${file.name}`);
		}
		if (response.data.byteLength !== file.size) throw new Error(`夸克下载长度不匹配：${file.name}`);
		return response.data;
	}

	private async requestDownload(file: RemoteFile, maxBytes?: number): Promise<HttpResponse> {
		const data = await this.requestApi(`${DRIVE_API}/file/download`, 'POST', {}, { fids: [file.fid] });
		const candidates: unknown = Array.isArray(data) ? data : asRecord(data).list;
		const entries: unknown[] = Array.isArray(candidates) ? candidates : [];
		const records = entries.map(asRecord);
		const matched = records.find((entry) => String(entry.fid ?? '') === file.fid);
		const info = matched ?? (records.length === 1 && records[0].fid === undefined ? records[0] : undefined);
		if (!info) throw new Error(`夸克下载地址未返回匹配文件：${file.name}`);
		const url = info?.download_url;
		if (typeof url !== 'string' || !url) throw new Error(`夸克未返回下载地址：${file.name}`);
		return await this.transport.request({
			url,
			method: 'GET',
			cookie: this.cookie,
			purpose: 'download',
			responseKind: 'arraybuffer',
			...(maxBytes === undefined ? {} : { maxResponseBytes: maxBytes }),
			headers: {
				Accept: 'application/octet-stream,*/*',
				Referer: 'https://pan.quark.cn/',
				'User-Agent': QUARK_WEB_USER_AGENT,
			},
		});
	}

	private async confirmUploaded(parentId: string, name: string, size: number, fid?: string): Promise<RemoteFile> {
		for (let attempt = 0; attempt < 4; attempt += 1) {
			const file = await this.findChildByName(parentId, name);
			if (file) {
				if (file.isDirectory || file.size !== size || (fid && file.fid !== fid)) throw new Error(`夸克上传后的文件校验失败：${name}`);
				return file;
			}
			if (attempt < 3) await delay(300 * (attempt + 1));
		}
		throw new Error(`夸克尚未确认文件上传完成：${name}`);
	}

	private async finalizeInstantUpload(
		parentId: string,
		name: string,
		size: number,
		taskId?: string,
		objKey?: string,
		fid?: string,
	): Promise<RemoteFile> {
		let finishError: unknown;
		if (taskId && objKey) {
			try {
				await this.requestApi(`${DRIVE_API}/file/upload/finish`, 'POST', {}, { task_id: taskId, obj_key: objKey });
			} catch (error) {
				finishError = error;
			}
		}
		try {
			return await this.confirmUploaded(parentId, name, size, fid);
		} catch (visibilityError) {
			if (finishError instanceof Error) throw finishError;
			throw visibilityError;
		}
	}

	private async requestApi(
		urlOrPath: string,
		method: 'GET' | 'POST',
		params: Record<string, string> = {},
		body?: Record<string, unknown>,
	): Promise<Record<string, unknown> | unknown[]> {
		const url = new URL(urlOrPath);
		if (url.hostname === 'drive-pc.quark.cn') {
			url.searchParams.set('pr', 'ucpro');
			url.searchParams.set('fr', 'pc');
			url.searchParams.set('uc_param_str', '');
			url.searchParams.set('__dt', '1000');
			url.searchParams.set('__t', String(Date.now()));
		}
		for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
		const request: HttpRequest = {
			url: url.toString(),
			method,
			cookie: this.cookie,
			headers: {
				Accept: 'application/json, text/plain, */*',
				Origin: 'https://pan.quark.cn',
				Referer: 'https://pan.quark.cn/',
				'User-Agent': QUARK_WEB_USER_AGENT,
				...(body ? { 'Content-Type': 'application/json' } : {}),
			},
			body: body ? JSON.stringify(body) : undefined,
			responseKind: 'text',
			purpose: 'api',
		};
		let response: HttpResponse;
		try {
			response = await this.transport.request(request);
		} catch (error) {
			if (error instanceof QuarkTransportError) throw error;
			throw new Error('连接夸克失败；请检查网络、Cookie 和 Obsidian 版本');
		}
		if (response.status === 401 || response.status === 403) throw new QuarkAuthenticationError(response.status);
		if (response.status < 200 || response.status >= 300) throw new Error(`夸克请求失败（HTTP ${response.status}）`);
		let envelope: ApiEnvelope;
		try {
			envelope = JSON.parse(response.text()) as ApiEnvelope;
		} catch {
			throw new Error('夸克响应无法解析，已暂停同步');
		}
		const isAccountInfo = url.hostname === 'pan.quark.cn' && url.pathname === '/account/info';
		const semanticStatus = readFiniteNumber(envelope.status);
		if (semanticStatus === 401 || semanticStatus === 403 || Number(envelope.code) === 401 || Number(envelope.code) === 403) {
			throw new QuarkAuthenticationError(semanticStatus === 401 || semanticStatus === 403 ? semanticStatus : Number(envelope.code));
		}
		if (envelope.success === false) throw new Error('夸克 API 返回失败状态');
		const allowedAccountInfoStatus = isAccountInfo && [0, 200, 2000000].includes(semanticStatus ?? NaN);
		if (semanticStatus !== undefined && (semanticStatus < 0 || semanticStatus >= 400) && !allowedAccountInfoStatus) {
			throw new Error(`夸克 API 返回错误状态 ${semanticStatus}`);
		}
		const codeText = envelope.code === undefined ? undefined : String(envelope.code).toUpperCase();
		const allowedAccountInfoCode = isAccountInfo && ['OK', '0', '200', '2000000'].includes(codeText ?? '');
		if (envelope.code !== undefined && Number(envelope.code) !== 0 && !allowedAccountInfoCode) {
			const code = String(envelope.code).slice(0, 24);
			throw new Error(`夸克 API 返回错误代码 ${code}`);
		}
		this.cookie = mergeQuarkSessionCookies(this.cookie, response.headers['set-cookie'] ?? response.headers['Set-Cookie']);
		if (!('data' in envelope)) return envelope;
		const payload = envelope.data ?? {};
		if (payload && typeof payload === 'object' && !Array.isArray(payload) && envelope.metadata !== undefined) {
			return { ...payload, __envelope_metadata: envelope.metadata };
		}
		return payload;
	}
}

const DOWNLOAD_FAILURES = new Map([
	['AccessDenied', { label: '访问被拒绝（AccessDenied）', retryable: false }],
	['InvalidAccessKeyId', { label: '下载凭据无效（InvalidAccessKeyId）', retryable: false }],
	['RequestExpired', { label: '下载地址已过期（RequestExpired）', retryable: true }],
	['SecurityTokenExpired', { label: '下载凭据已过期（SecurityTokenExpired）', retryable: true }],
	['ExpiredToken', { label: '下载凭据已过期（ExpiredToken）', retryable: true }],
	['SignatureDoesNotMatch', { label: '下载签名不匹配（SignatureDoesNotMatch）', retryable: true }],
]);

function readDownloadFailure(bytes: Uint8Array): { label: string; retryable: boolean } | undefined {
	const text = new TextDecoder().decode(bytes.subarray(0, 2048));
	const code = /<Code>\s*([A-Za-z]+)\s*<\/Code>/i.exec(text)?.[1] ??
		/"code"\s*:\s*"([A-Za-z]+)"/i.exec(text)?.[1] ?? text.trim();
	return DOWNLOAD_FAILURES.get(code);
}

function readTotal(data: Record<string, unknown>): number | undefined {
	const metadata = asRecord(data.metadata);
	const envelopeMetadata = asRecord(data.__envelope_metadata);
	const pageInfo = asRecord(data.page_info);
	const candidates = [
		data.total,
		data._total,
		data.total_count,
		data.count,
		data.file_count,
		metadata._total,
		metadata.total,
		envelopeMetadata._total,
		envelopeMetadata.total,
		pageInfo.total,
	];
	for (const candidate of candidates) {
		const total = readNonNegativeNumber(candidate);
		if (total !== undefined) return total;
	}
	return undefined;
}

function normalizeRemoteFile(input: unknown): RemoteFile {
	const record = asRecord(input);
	const fid = record.fid ?? record.id;
	const name = record.file_name ?? record.name;
	if (fid === undefined || typeof name !== 'string' || name.length === 0) throw new Error('夸克目录条目缺少编号或文件名，已暂停同步');
	const type = record.file_type;
	const isDirectory = record.dir === true || record.dir === 1 || type === 0 || type === '0' || type === 'folder';
	const size = readNonNegativeNumber(record.size) ?? 0;
	const parent = record.pdir_fid;
	const parentFid = typeof parent === 'string' && /^[\w-]{1,128}$/.test(parent) ? parent : parent === 0 ? '0' : undefined;
	const updatedAt = readNonNegativeNumber(record.updated_at ?? record.l_updated_at);
	const imagePreviewUrls = [record.thumbnail, record.big_thumbnail, record.preview_url]
		.filter((value): value is string => typeof value === 'string' && value.startsWith('https://'));
	return {
		fid: String(fid), name, isDirectory, size,
		...(parentFid !== undefined ? { parentFid } : {}),
		...(updatedAt !== undefined ? { updatedAt } : {}),
		...(imagePreviewUrls.length ? { imagePreviewUrls } : {}),
	};
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readNonNegativeNumber(value: unknown): number | undefined {
	const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
	return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
	const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
	return Number.isFinite(number) ? number : undefined;
}

function readPositiveNumber(value: unknown): number | undefined {
	const number = readNonNegativeNumber(value);
	return number !== undefined && number > 0 ? number : undefined;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = typeof window === 'undefined' ? globalThis : window;
		timer.setTimeout(resolve, milliseconds);
	});
}

function firstString(...values: unknown[]): string | undefined {
	const value = values.find((candidate) => typeof candidate === 'string' && candidate.length > 0);
	return typeof value === 'string' ? value : undefined;
}

function requiredString(value: unknown, message: string): string {
	if (typeof value !== 'string' || value.length === 0) throw new Error(message);
	return value;
}

function isFinished(value: Record<string, unknown>): boolean {
	const finish = value.finish;
	return finish === true || finish === 1 || finish === '1' || finish === 'true';
}

function buildUploadHost(bucket: string, rawHost: string): string {
	if (!/^[a-z0-9-]+$/i.test(bucket)) throw new Error('夸克上传 bucket 无效');
	if (!rawHost || rawHost !== rawHost.trim()) throw new Error('夸克上传主机无效');
	const input = /^https?:\/\//i.test(rawHost)
		? rawHost.replace(/^http:\/\//i, 'https://')
		: `https://${rawHost}`;
	let candidate: URL;
	try {
		candidate = new URL(input);
	} catch {
		throw new Error('夸克上传主机无效');
	}
	if (candidate.protocol !== 'https:' || candidate.username || candidate.password || candidate.port || candidate.search || candidate.hash || candidate.pathname !== '/') {
		throw new Error('夸克上传主机无效');
	}
	const isPdsHost = candidate.hostname === 'pds.quark.cn' || candidate.hostname.endsWith('.pds.quark.cn');
	const isAliyunHost = candidate.hostname === 'aliyuncs.com' || candidate.hostname.endsWith('.aliyuncs.com');
	if (!isPdsHost && !isAliyunHost) throw new Error('夸克上传主机不在允许列表');
	const hostname = candidate.hostname.startsWith(`${bucket}.`) ? candidate.hostname : `${bucket}.${candidate.hostname}`;
	return `https://${hostname}`;
}

function buildPartUrl(host: string, objectKey: string, partNumber: number, uploadId: string): string {
	return `${host}/${encodeObjectKey(objectKey)}?partNumber=${partNumber}&uploadId=${encodeURIComponent(uploadId)}`;
}

function encodeObjectKey(value: string): string {
	return value.split('/').map((part) => encodeURIComponent(part)).join('/');
}

function utf8ToBase64(value: string): string {
	const bytes = new TextEncoder().encode(value);
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
	}
	return btoa(binary);
}

function readAccountId(input: unknown): string | undefined {
	const fields = new Set(['account_id', 'accountId', 'member_id', 'memberId', 'uid', 'user_id', 'userId', 'id']);
	const queue: unknown[] = [input];
	const visited = new Set<object>();
	for (let depth = 0; queue.length > 0 && depth < 64; depth += 1) {
		const value = queue.shift();
		if (!value || typeof value !== 'object' || Array.isArray(value) || visited.has(value)) continue;
		visited.add(value);
		const record = value as Record<string, unknown>;
		for (const [key, candidate] of Object.entries(record)) {
			if (fields.has(key) && (typeof candidate === 'string' || typeof candidate === 'number')) {
				const accountId = String(candidate).trim();
				if (/^[\w-]{1,128}$/.test(accountId)) return accountId;
			}
			if (candidate && typeof candidate === 'object') queue.push(candidate);
		}
	}
	return undefined;
}

function readAccountNickname(input: unknown): string | undefined {
	const fields = new Set(['nickname', 'nick_name']);
	const queue: unknown[] = [input];
	const visited = new Set<object>();
	for (let count = 0; queue.length > 0 && count < 64; count += 1) {
		const value = queue.shift();
		if (!value || typeof value !== 'object' || Array.isArray(value) || visited.has(value)) continue;
		visited.add(value);
		for (const [key, candidate] of Object.entries(value as Record<string, unknown>)) {
			if (fields.has(key) && typeof candidate === 'string') {
				const nickname = candidate.trim();
				if (nickname && Array.from(nickname).length <= 128 && !hasAsciiControl(nickname)) return nickname;
			}
			if (candidate && typeof candidate === 'object') queue.push(candidate);
		}
	}
	return undefined;
}

function readCookieValue(cookie: string, name: string): string | undefined {
	for (const part of cookie.split(';')) {
		const separator = part.indexOf('=');
		if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
		const value = part.slice(separator + 1).trim();
		if (/^[\w-]{1,128}$/.test(value)) return value;
	}
	return undefined;
}

function mergeQuarkSessionCookies(cookie: string, setCookie: string | undefined): string {
	if (!setCookie) return cookie;
	const allowed = new Set(['__pus', '__puus', '__kps', '__uid']);
	const values = new Map<string, string>();
	for (const part of cookie.split(';')) {
		const separator = part.indexOf('=');
		if (separator <= 0) continue;
		const name = part.slice(0, separator).trim();
		const value = part.slice(separator + 1).trim();
		if (allowed.has(name) && value && !hasAsciiControl(value)) values.set(name, value);
	}
	const lines = setCookie.split(/[\r\n]+/).flatMap((line) => line.split(/,\s*(?=[!#$%&'*+.^_`|~0-9A-Za-z-]+=)/));
	for (const line of lines) {
		const match = /^\s*([^=;\s]+)=([^;\r\n]*)/.exec(line);
		if (!match || !allowed.has(match[1])) continue;
		const value = match[2].trim();
		if (value && !hasAsciiControl(value)) values.set(match[1], value);
	}
	return Array.from(values, ([name, value]) => `${name}=${value}`).join('; ') || cookie;
}
