import assert from 'node:assert/strict';
import test from 'node:test';
import { md5Hex, sha1Hex, sha256Hex } from '../src/hash.ts';

const bytes = (value: string) => new TextEncoder().encode(value);

test('SHA-256 returns standard content-address values for empty and UTF-8 input', async () => {
	assert.equal(await sha256Hex(bytes('')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
	assert.equal(await sha256Hex(bytes('你好')), '670d9743542cae3ea7ebe36af56bd53648b0a1126162e78d81a32934a711302e');
});

test('MD5 and SHA-1 match the values Quark uses for upload hash checks', async () => {
	assert.equal(md5Hex(bytes('')), 'd41d8cd98f00b204e9800998ecf8427e');
	assert.equal(md5Hex(bytes('abc')), '900150983cd24fb0d6963f7d28e17f72');
	assert.equal(await sha1Hex(bytes('abc')), 'a9993e364706816aba3e25717850c26c9cd0d89d');
});
