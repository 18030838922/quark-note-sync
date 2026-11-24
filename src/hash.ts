export async function sha256Hex(input: Uint8Array): Promise<string> {
	return bytesToHex(await digest('SHA-256', input));
}

export async function sha1Hex(input: Uint8Array): Promise<string> {
	return bytesToHex(await digest('SHA-1', input));
}

export function md5Bytes(input: Uint8Array): Uint8Array {
	const bitLength = BigInt(input.byteLength) * 8n;
	const paddedLength = Math.ceil((input.byteLength + 9) / 64) * 64;
	const padded = new Uint8Array(paddedLength);
	padded.set(input);
	padded[input.byteLength] = 0x80;
	for (let index = 0; index < 8; index += 1) padded[paddedLength - 8 + index] = Number((bitLength >> BigInt(index * 8)) & 0xffn);

	const shift = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
		5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
		4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
		6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
	const constants = Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) >>> 0);
	let a0 = 0x67452301;
	let b0 = 0xefcdab89;
	let c0 = 0x98badcfe;
	let d0 = 0x10325476;

	for (let offset = 0; offset < paddedLength; offset += 64) {
		const words = new Uint32Array(16);
		for (let index = 0; index < 16; index += 1) {
			const start = offset + index * 4;
			words[index] = (padded[start] | (padded[start + 1] << 8) | (padded[start + 2] << 16) | (padded[start + 3] << 24)) >>> 0;
		}
		let a = a0;
		let b = b0;
		let c = c0;
		let d = d0;
		for (let index = 0; index < 64; index += 1) {
			let f: number;
			let g: number;
			if (index < 16) {
				f = (b & c) | (~b & d);
				g = index;
			} else if (index < 32) {
				f = (d & b) | (~d & c);
				g = (5 * index + 1) % 16;
			} else if (index < 48) {
				f = b ^ c ^ d;
				g = (3 * index + 5) % 16;
			} else {
				f = c ^ (b | ~d);
				g = (7 * index) % 16;
			}
			const sum = (a + f + constants[index] + words[g]) >>> 0;
			const rotated = ((sum << shift[index]) | (sum >>> (32 - shift[index]))) >>> 0;
			const nextB = (b + rotated) >>> 0;
			a = d;
			d = c;
			c = b;
			b = nextB;
		}
		a0 = (a0 + a) >>> 0;
		b0 = (b0 + b) >>> 0;
		c0 = (c0 + c) >>> 0;
		d0 = (d0 + d) >>> 0;
	}
	const output = new Uint8Array(16);
	[a0, b0, c0, d0].forEach((word, index) => {
		output[index * 4] = word & 0xff;
		output[index * 4 + 1] = (word >>> 8) & 0xff;
		output[index * 4 + 2] = (word >>> 16) & 0xff;
		output[index * 4 + 3] = (word >>> 24) & 0xff;
	});
	return output;
}

export function md5Hex(input: Uint8Array): string {
	return bytesToHex(md5Bytes(input));
}

export function md5Base64(input: Uint8Array): string {
	let binary = '';
	for (const byte of md5Bytes(input)) binary += String.fromCharCode(byte);
	return btoa(binary);
}

async function digest(algorithm: 'SHA-1' | 'SHA-256', input: Uint8Array): Promise<Uint8Array> {
	if (!globalThis.crypto?.subtle) throw new Error('此设备不支持 Web Crypto');
	const source = input.slice();
	return new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, source));
}

function bytesToHex(input: Uint8Array): string {
	return Array.from(input, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
