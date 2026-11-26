import Hls, { LoadStats, type Loader, type LoaderCallbacks, type LoaderConfiguration, type LoaderContext } from 'hls.js';
import { QuarkTransport, type HttpResponse } from './transport.ts';

export interface VideoStream {
	url: string;
	transport: Pick<QuarkTransport, 'request'>;
	language: 'zh-CN' | 'en';
	officialUrl?: string;
}

export function mountQuarkVideo(container: HTMLElement, stream: VideoStream): () => void {
	const video = createEl('video');
	video.controls = true;
	video.playsInline = true;
	video.preload = 'none';
	video.className = 'quark-inline-media-video';
	const button = container.createEl('button');
	button.type = 'button';
	button.textContent = stream.language === 'en' ? 'Play from Quark' : '在线播放';
	const status = container.createSpan({ attr: { role: 'status' } });
	const fallback = createEl('a');
	fallback.textContent = stream.language === 'en' ? 'Open Quark' : '打开夸克';
	fallback.target = '_blank';
	fallback.rel = 'noopener noreferrer';
	fallback.hidden = true;
	if (stream.officialUrl) {
		fallback.href = stream.officialUrl;
		container.append(fallback);
	}

	let player: Hls | undefined;
	const clear = () => {
		player?.destroy();
		player = undefined;
		video.remove();
	};
	button.addEventListener('click', () => {
		if (!Hls.isSupported()) {
			fallback.hidden = false;
			status.textContent = stream.language === 'en' ? 'Open Quark to play on this device.' : '请在夸克中播放，当前设备的 Obsidian 不支持此视频流。';
			return;
		}
		clear();
		button.hidden = true;
		fallback.hidden = true;
		status.textContent = '';
		container.append(video);
		const loader = stream.transport;
		player = new Hls({
			enableWorker: false, maxBufferLength: 20, maxMaxBufferLength: 40, backBufferLength: 20,
			loader: class extends QuarkStreamLoader {
				constructor() { super(loader); }
			},
		});
		player.on(Hls.Events.ERROR, (_event, error) => {
			if (!error.fatal) return;
			clear();
			button.hidden = false;
			fallback.hidden = false;
			status.textContent = stream.language === 'en' ? 'Playback failed. Reopen the video for a fresh link or play it in Quark.' : '播放失败。请重新打开视频以刷新地址，或在夸克中播放。';
		});
		player.on(Hls.Events.MANIFEST_PARSED, () => { void video.play().catch(() => {}); });
		player.loadSource(stream.url);
		player.attachMedia(video);
	});
	return clear;
}

class QuarkStreamLoader implements Loader<LoaderContext> {
	context: LoaderContext | null = null;
	stats = new LoadStats();
	private timer?: number;
	private readonly controller = new AbortController();
	private headers?: Record<string, string>;

	constructor(private readonly transport: VideoStream['transport']) {}

	load(context: LoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>): void {
		this.context = context;
		const stats = this.stats;
		stats.loading.start = performance.now();
		const binary = context.responseType === 'arraybuffer';
		const ranged = context.rangeEnd !== undefined && context.rangeStart !== undefined && context.rangeEnd > context.rangeStart;
		const headers = ranged ? { Range: `bytes=${context.rangeStart}-${context.rangeEnd! - 1}` } : undefined;
		this.timer = window.setTimeout(() => {
			this.abort();
			callbacks.onTimeout(stats, context, null);
		}, Math.min(config.loadPolicy.maxLoadTimeMs, 30000));
		void this.transport.request({
			url: context.url, purpose: 'video-stream', method: 'GET', headers, signal: this.controller.signal,
			responseKind: binary ? 'arraybuffer' : 'text', maxResponseBytes: binary ? 24 * 1024 * 1024 : 2 * 1024 * 1024,
		}).then((response: HttpResponse) => {
			if (stats.aborted) return;
			window.clearTimeout(this.timer);
			const text = binary ? undefined : response.text();
			if (response.status !== (ranged ? 206 : 200) || text !== undefined && !text.trimStart().startsWith('#EXTM3U')) {
				callbacks.onError({ code: response.status, text: 'Quark video data unavailable' }, context, null, stats);
				return;
			}
			this.headers = response.headers;
			stats.loading.first = stats.loading.end = performance.now();
			stats.loaded = stats.total = response.data.byteLength;
			const data = text ?? new Uint8Array(response.data).buffer;
			callbacks.onProgress?.(stats, context, data, null);
			callbacks.onSuccess({ url: context.url, data, code: response.status }, stats, context, null);
		}, () => {
			if (stats.aborted) return;
			window.clearTimeout(this.timer);
			callbacks.onError({ code: 0, text: 'Quark video request failed' }, context, null, stats);
		});
	}

	getResponseHeader(name: string): string | null { return this.headers?.[name.toLowerCase()] ?? null; }
	abort(): void {
		this.stats.aborted = true;
		window.clearTimeout(this.timer);
		this.controller.abort();
	}
	destroy(): void { this.abort(); this.context = null; }
}
