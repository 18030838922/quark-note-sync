import { hasAsciiControl } from './core.ts';
const VERSION = 1;
const CODE_PREFIX = 'QPS1';
const DOMAIN = 'quark-note-sync/pairing-code/v1';
const PBKDF2_ITERATIONS = 600_000;
const PAIRING_TTL_MS = 15 * 60 * 1_000;
const ALLOWED_CLOCK_SKEW_MS = 2 * 60 * 1_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const MAX_CODE_LENGTH = 32 * 1024;
const MAX_CIPHERTEXT_BYTES = 24 * 1024;
const MAX_COOKIE_LENGTH = 16 * 1024;
const MAX_FIELD_LENGTH = 512;
const MIN_PASSPHRASE_CHARACTERS = 12;
const MAX_PASSPHRASE_LENGTH = 1_024;

export type PairingPayload = {
	cookie: string;
	cloudDirectoryName: string;
	accountId: string;
	rootFid: string;
};

type EncryptedPayload = PairingPayload & {
	version: typeof VERSION;
	expiresAt: number;
};

const encoder = new TextEncoder();

function getCrypto(): Crypto {
	const cryptoApi = typeof window === 'undefined' ? crypto : window.crypto ?? crypto;
	if (!cryptoApi?.subtle || typeof cryptoApi.getRandomValues !== 'function') {
		throw new Error('当前环境不支持安全的配对码加密');
	}
	return cryptoApi;
}

function validatePassphrase(password: string): Uint8Array<ArrayBuffer> {
	if (typeof password !== 'string') throw new Error('口令必须是文本');
	const characterCount = Array.from(password).length;
	if (characterCount < MIN_PASSPHRASE_CHARACTERS) {
		throw new Error('配对口令至少需要 12 个字符');
	}
	if (password.length > MAX_PASSPHRASE_LENGTH) throw new Error('配对口令过长');
	return encoder.encode(password);
}

function validateNow(now: number | undefined): number {
	const value = now ?? Date.now();
	if (!Number.isSafeInteger(value) || value < 0) throw new Error('时间参数无效');
	return value;
}

function validateTextField(value: unknown, label: string, maxLength: number): asserts value is string {
	if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
		throw new Error(`${label}无效`);
	}
	if (hasAsciiControl(value)) throw new Error(`${label}包含无效字符`);
}

function validatePayload(payload: PairingPayload): PairingPayload {
	if (!payload || typeof payload !== 'object') throw new Error('配对信息无效');
	validateTextField(payload.cookie, 'Cookie', MAX_COOKIE_LENGTH);
	if (!/^[^;=\s]+=[^;]*(?:;\s*[^;=\s]+=[^;]*)*$/.test(payload.cookie)) {
		throw new Error('Cookie 格式无效');
	}
	validateTextField(payload.cloudDirectoryName, '云端目录名', MAX_FIELD_LENGTH);
	validateTextField(payload.accountId, '账号 ID', MAX_FIELD_LENGTH);
	validateTextField(payload.rootFid, '根目录 ID', MAX_FIELD_LENGTH);
	return {
		cookie: payload.cookie,
		cloudDirectoryName: payload.cloudDirectoryName,
		accountId: payload.accountId,
		rootFid: payload.rootFid,
	};
}

function encodeBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
	if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
		throw new Error('配对码格式无效');
	}
	const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
	let binary: string;
	try {
		binary = atob(padded);
	} catch {
		throw new Error('配对码格式无效');
	}
	const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
	if (encodeBase64Url(bytes) !== value) throw new Error('配对码格式无效');
	return bytes;
}

async function deriveKey(passwordBytes: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
	const cryptoApi = getCrypto();
	const material = await cryptoApi.subtle.importKey('raw', passwordBytes, 'PBKDF2', false, ['deriveKey']);
	return cryptoApi.subtle.deriveKey(
		{ name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
		material,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt'],
	);
}

export async function createPairingCode(
	payload: PairingPayload,
	password: string,
	now?: number,
): Promise<string> {
	const safePayload = validatePayload(payload);
	const passwordBytes = validatePassphrase(password);
	const currentTime = validateNow(now);
	const expiresAt = currentTime + PAIRING_TTL_MS;
	if (!Number.isSafeInteger(expiresAt)) throw new Error('时间参数无效');

	const cryptoApi = getCrypto();
	const salt = cryptoApi.getRandomValues(new Uint8Array(SALT_BYTES));
	const iv = cryptoApi.getRandomValues(new Uint8Array(IV_BYTES));
	const key = await deriveKey(passwordBytes, salt);
	const plaintext: EncryptedPayload = { version: VERSION, expiresAt, ...safePayload };
	const ciphertext = await cryptoApi.subtle.encrypt(
		{ name: 'AES-GCM', iv, additionalData: encoder.encode(DOMAIN), tagLength: 128 },
		key,
		encoder.encode(JSON.stringify(plaintext)),
	);
	const encryptedBytes = new Uint8Array(ciphertext);
	if (encryptedBytes.length > MAX_CIPHERTEXT_BYTES) throw new Error('配对信息过长');
	const code = `${CODE_PREFIX}.${encodeBase64Url(salt)}.${encodeBase64Url(iv)}.${encodeBase64Url(encryptedBytes)}`;
	if (code.length > MAX_CODE_LENGTH) throw new Error('配对码长度无效');
	return code;
}

function parseCode(code: string): {
	salt: Uint8Array<ArrayBuffer>;
	iv: Uint8Array<ArrayBuffer>;
	ciphertext: Uint8Array<ArrayBuffer>;
} {
	if (typeof code !== 'string' || code.length > MAX_CODE_LENGTH) throw new Error('配对码长度无效');
	const parts = code.split('.');
	if (parts[0] !== CODE_PREFIX) {
		if (/^QPS[0-9A-Za-z_-]+$/.test(parts[0] ?? '')) throw new Error('不支持此配对码版本');
		throw new Error('配对码格式无效');
	}
	if (parts.length !== 4) throw new Error('配对码格式无效');
	const salt = decodeBase64Url(parts[1]);
	const iv = decodeBase64Url(parts[2]);
	const ciphertext = decodeBase64Url(parts[3]);
	if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES || ciphertext.length < 16 || ciphertext.length > MAX_CIPHERTEXT_BYTES) {
		throw new Error('配对码格式无效');
	}
	return { salt, iv, ciphertext };
}

function validateDecryptedPayload(value: unknown, now: number): PairingPayload {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配对码内容无效');
	const candidate = value as Partial<EncryptedPayload>;
	if (candidate.version !== VERSION) throw new Error('配对码版本无效');
	if (!Number.isSafeInteger(candidate.expiresAt) || candidate.expiresAt! <= now) {
		throw new Error('配对码已过期');
	}
	if (candidate.expiresAt! > now + PAIRING_TTL_MS + ALLOWED_CLOCK_SKEW_MS) throw new Error('配对码有效期无效');
	return validatePayload(candidate as PairingPayload);
}

export async function readPairingCode(code: string, password: string, now?: number): Promise<PairingPayload> {
	const parsed = parseCode(code);
	const passwordBytes = validatePassphrase(password);
	const currentTime = validateNow(now);
	const cryptoApi = getCrypto();
	const key = await deriveKey(passwordBytes, parsed.salt);
	let plaintext: ArrayBuffer;
	try {
		plaintext = await cryptoApi.subtle.decrypt(
			{ name: 'AES-GCM', iv: parsed.iv, additionalData: encoder.encode(DOMAIN), tagLength: 128 },
			key,
			parsed.ciphertext,
		);
	} catch {
		throw new Error('配对码解密失败，请检查口令或代码是否完整');
	}
	let decoded: unknown;
	try {
		decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
	} catch {
		throw new Error('配对码内容无效');
	}
	return validateDecryptedPayload(decoded, currentTime);
}
