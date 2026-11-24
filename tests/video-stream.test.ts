import assert from 'node:assert/strict';
import test from 'node:test';
import { selectQuarkVideoStream } from '../src/video-stream-url.ts';
import { classifyQuarkUrl, createSafeHeaders } from '../src/transport.ts';

const stream = 'https://video-play-h-share-preview-zb.drive.quark.cn/play.m3u8?sig=fixture';

test('personal and public playback responses resolve to a Quark HLS URL', () => {
	assert.equal(selectQuarkVideoStream({ video_list: [{ video_info: { url: stream, format: 'm3u8' } }] }), stream);
	assert.equal(selectQuarkVideoStream({ accessable: true, play_info: { url: stream, format: 'm3u8', success: true } }), stream);
	assert.throws(() => selectQuarkVideoStream({ accessable: false, play_info: {url: stream} }), /授权/);
	assert.throws(() => selectQuarkVideoStream({ play_info: {url: 'https://example.com/play.m3u8'} }), /在线播放/);
});

test('stream requests keep byte ranges and withhold Quark credentials', () => {
	assert.deepEqual(createSafeHeaders(stream, 'sid=fixture', { Cookie:'sid=extra', Range:'bytes=0-99' }, 'video-stream'), { Range:'bytes=0-99' });
	assert.throws(() => classifyQuarkUrl(stream, 'api'), /主机/);
	assert.throws(() => classifyQuarkUrl('https://video-play-test.drive.quark.cn.example.com/file', 'video-stream'), /主机/);
});


test('authenticated video playback accepts the private Quark CDN returned for a ready rendition', () => {
	const url = 'https://video-h-fkad-zb.drive.quark.cn/play.m3u8?sig=fixture';
	const video_info = { url, format: 'm3u8', success: true };
	assert.equal(selectQuarkVideoStream({ video_list: [{ video_info, accessable: true, trans_status: 'success' }] }), url);
	assert.throws(() => selectQuarkVideoStream({ video_list: [{ video_info, accessable: false }] }), /在线播放/);
	assert.throws(() => classifyQuarkUrl(url, 'api'), /主机/);
	assert.deepEqual(createSafeHeaders(url, 'sid=fixture', {}, 'video-stream'), {});
	assert.deepEqual(createSafeHeaders(url, 'sid=fixture', { Cookie: 'ignored' }, 'private-video-stream'), { Cookie: 'sid=fixture' });
	assert.throws(() => createSafeHeaders(stream, 'sid=fixture', {}, 'private-video-stream'), /主机/);
});
