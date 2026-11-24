import { classifyQuarkUrl } from './transport.ts';

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function selectQuarkVideoStream(data: unknown): string {
	const envelope = record(data);
	if (envelope.accessable === false || envelope.accessible === false) {
		throw new Error('夸克未授权播放此视频');
	}
	for (const list of [envelope.play_info, envelope.video_list, data]) {
		const entries = Array.isArray(list) ? list : [list];
		for (const value of entries) {
			const row = record(value);
			const info = record(row.video_info);
			const url = info.url ?? row.url;
			const format = info.format ?? row.format;
			if (typeof url !== 'string' || row.accessable === false || row.accessible === false || row.success === false || info.success === false) continue;
			try {
				if (format !== 'm3u8' && format !== 'hls' && !new URL(url).pathname.endsWith('.m3u8')) continue;
				classifyQuarkUrl(url, 'video-stream');
				return url;
			} catch {
				// Ignore URLs outside Quark playback hosts.
			}
		}
	}
	throw new Error('夸克未返回可用的在线播放地址');
}
