import { loadPdfJs } from 'obsidian';
import { attachPreviewPinch } from './preview-pinch.ts';

interface PdfViewport {
	width: number;
	height: number;
}

interface PdfPage {
	getViewport(options: { scale: number }): PdfViewport;
	render(options: {
		canvas: HTMLCanvasElement;
		canvasContext: CanvasRenderingContext2D;
		viewport: PdfViewport;
	}): { promise: Promise<void>; cancel(): void };
	cleanup(): void;
}

interface PdfDocument {
	numPages: number;
	getPage(pageNumber: number): Promise<PdfPage>;
}

interface PdfLoadingTask {
	promise: Promise<PdfDocument>;
	destroy(): Promise<void>;
}

interface PdfLibrary {
	getDocument(options: { data: Uint8Array; isEvalSupported: false }): PdfLoadingTask;
}

interface PageSlot {
	element: HTMLElement;
	aspect: number;
	failed?: boolean;
}

interface RenderedPage {
	canvas: HTMLCanvasElement;
	displayWidth: number;
}

interface PageRender {
	index: number;
	task?: ReturnType<PdfPage['render']>;
	canvas?: HTMLCanvasElement;
}

export interface PdfReadingPosition {
	page: number;
	zoom: number;
}

const FIT_WIDTH = 1;
const MAX_ZOOM = 3;
const MAX_RENDERED_PAGES = 6;
const MAX_CANVAS_PIXELS = 2_000_000;

function pdfPageAspect({ width, height }: PdfViewport): number {
	const aspect = width / height;
	if (!Number.isFinite(aspect) || width <= 0 || height <= 0 || aspect <= 0) {
		throw new Error('Invalid PDF viewport');
	}
	return aspect;
}

function pdfCanvasScale({ width, height }: PdfViewport, displayWidth: number, pixelRatio: number): number {
	const target = displayWidth * Math.min(Math.max(pixelRatio, 1), 2) / width;
	return Math.min(target, 4096 / width, 4096 / height, Math.sqrt(MAX_CANVAS_PIXELS / width / height));
}

function releaseCanvas(canvas: HTMLCanvasElement): void {
	canvas.remove();
	canvas.width = canvas.height = 0;
}

export function mountMobilePdfPreview(
	container: HTMLElement,
	bytes: Uint8Array,
	language: 'zh-CN' | 'en',
	showFallback: () => void,
	initialPosition?: PdfReadingPosition,
	onPositionChange?: (position: PdfReadingPosition) => void,
): () => void {
	const label = (chinese: string, english: string) => language === 'en' ? english : chinese;
	const win = container.win;
	const reader = container.createDiv({ cls: 'quark-pdf-reader' });
	const count = reader.createSpan({ cls: 'quark-pdf-page-count', attr: { role: 'status' } });
	count.hidden = true;
	const status = reader.createEl('p', { cls: 'quark-pdf-status', attr: { role: 'status' } });
	status.setText(label('正在加载 PDF…', 'Loading PDF…'));
	const viewport = reader.createDiv({ cls: 'quark-pdf-viewport', attr: {
		tabindex: '0', 'aria-label': label('PDF 阅读区', 'PDF reader'),
	} });
	const stack = viewport.createDiv({ cls: 'quark-pdf-pages' });
	const slots: PageSlot[] = [];
	const rendered = new Map<number, RenderedPage>();
	let wanted: number[] = [];
	let active: PageRender | undefined;
	let loadingTask: PdfLoadingTask | undefined;
	let documentPdf: PdfDocument | undefined;
	let frame: number | undefined;
	let saveTimer: number | undefined;
	let lastSaved = initialPosition;
	let current = 0;
	const initialZoom = initialPosition?.zoom ?? FIT_WIDTH;
	let zoom = Number.isFinite(initialZoom) ? Math.min(MAX_ZOOM, Math.max(FIT_WIDTH, initialZoom)) : FIT_WIDTH;
	let layoutWidth = 0;
	let lastScrollTop = 0;
	let pinching = false;
	let painted = false;
	let closed = false;
	let failed = false;
	container.addClass('quark-pdf-preview-active');

	const pageWidth = () => Math.round(layoutWidth * zoom);
	const savePosition = () => {
		if (saveTimer !== undefined) win.clearTimeout(saveTimer);
		saveTimer = undefined;
		if (!painted) return;
		const page = current + 1;
		if (lastSaved?.page === page && lastSaved.zoom === zoom) return;
		lastSaved = { page, zoom };
		onPositionChange?.(lastSaved);
	};
	const scheduleSave = () => {
		if (!painted || pinching) return;
		if (lastSaved?.page === current + 1 && lastSaved.zoom === zoom) return;
		if (saveTimer !== undefined) win.clearTimeout(saveTimer);
		saveTimer = win.setTimeout(savePosition, 200);
	};
	const releaseRendered = () => {
		for (const { canvas } of rendered.values()) releaseCanvas(canvas);
		rendered.clear();
	};
	const stop = () => {
		if (frame !== undefined) win.cancelAnimationFrame(frame);
		frame = undefined;
		resizeObserver.disconnect();
		removePinch();
		viewport.removeEventListener('scroll', schedule);
		active?.task?.cancel();
		if (active?.canvas) releaseCanvas(active.canvas);
		releaseRendered();
		if (loadingTask) void loadingTask.destroy().catch(() => {});
		container.removeClass('quark-pdf-preview-active');
	};
	const fail = () => {
		if (closed || failed) return;
		failed = true;
		stop();
		count.hidden = viewport.hidden = true;
		status.hidden = false;
		status.setText(label('无法渲染 PDF。文件可能已加密、损坏或不受支持。', 'Could not render this PDF. The file may be encrypted, damaged, or unsupported.'));
		showFallback();
	};

	const pageAt = (y: number) => {
		let low = 0;
		let high = slots.length;
		while (low + 1 < high) {
			const middle = (low + high) >>> 1;
			if (slots[middle].element.offsetTop > y) high = middle;
			else low = middle;
		}
		return low;
	};
	const captureAnchor = (y: number) => {
		const element = slots[pageAt(y)].element;
		const offset = y - element.offsetTop;
		const height = Math.max(1, element.offsetHeight);
		return { element, fraction: Math.min(offset / height, 1), gap: Math.max(0, offset - height) };
	};
	const restoreAnchor = (anchor: ReturnType<typeof captureAnchor>, y: number) => {
		viewport.scrollTop = anchor.element.offsetTop + anchor.element.offsetHeight * anchor.fraction + anchor.gap - y;
		lastScrollTop = viewport.scrollTop;
	};
	const updateAspect = (slot: PageSlot, aspect: number) => {
		updateCurrent();
		const anchor = captureAnchor(viewport.scrollTop);
		slot.aspect = aspect;
		slot.element.setCssProps({ '--quark-pdf-page-aspect': String(aspect) });
		restoreAnchor(anchor, 0);
	};
	const updateCurrent = () => {
		if (viewport.scrollTop === lastScrollTop) return;
		lastScrollTop = viewport.scrollTop;
		const maxTop = viewport.scrollHeight - viewport.clientHeight;
		current = maxTop > 1 && lastScrollTop >= maxTop - 1
			? slots.length - 1
			: pageAt(lastScrollTop + Math.min(64, viewport.clientHeight / 8));
	};
	const showPageCount = () => {
		const page = current + 1;
		const total = slots.length;
		const text = label('第 ' + page + ' / ' + total + ' 页', page + ' / ' + total);
		if (count.textContent === text) return;
		count.setText(text);
		count.setAttr('aria-label', label('第 ' + page + ' 页，共 ' + total + ' 页', 'Page ' + page + ' of ' + total));
	};

	const renderPage = async (index: number, pdf: PdfDocument) => {
		const job: PageRender = { index };
		active = job;
		const slot = slots[index];
		let page: PdfPage | undefined;
		let committed = false;
		try {
			page = await pdf.getPage(index + 1);
			if (closed || failed || !wanted.includes(index)) return;
			const base = page.getViewport({ scale: 1 });
			const aspect = pdfPageAspect(base);
			if (slot.aspect !== aspect) updateAspect(slot, aspect);
			const displayWidth = pageWidth();
			const scale = pdfCanvasScale(base, displayWidth, win.devicePixelRatio);
			const pageViewport = page.getViewport({ scale });
			const canvas = container.doc.adoptNode(createEl('canvas', { cls: 'quark-pdf-canvas' }));
			canvas.width = Math.max(1, Math.floor(pageViewport.width));
			canvas.height = Math.max(1, Math.floor(pageViewport.height));
			job.canvas = canvas;
			const context = canvas.getContext('2d', { alpha: false });
			if (!context) throw new Error('PDF canvas is unavailable');
			job.task = page.render({ canvas, canvasContext: context, viewport: pageViewport });
			await job.task.promise;
			if (closed || failed || !wanted.includes(index)) return;
			const previous = rendered.get(index);
			if (previous) releaseCanvas(previous.canvas);
			slot.element.appendChild(canvas);
			rendered.set(index, { canvas, displayWidth });
			committed = true;
			painted = true;
			status.hidden = true;
			scheduleSave();
		} catch (error) {
			if (closed || failed || (error as Error | undefined)?.name === 'RenderingCancelledException') return;
			if (!painted && index === current) {
				fail();
			} else {
				slot.failed = true;
				if (!rendered.has(index)) slot.element.setText(label('此页无法显示', 'This page could not be rendered'));
			}
		} finally {
			if (!committed && job.canvas) releaseCanvas(job.canvas);
			if (!closed && !failed) page?.cleanup();
			active = undefined;
			schedule();
		}
	};

	function refresh(): void {
		frame = undefined;
		if (closed || failed || !slots.length || !layoutWidth || !viewport.clientHeight || !documentPdf) return;
		updateCurrent();
		showPageCount();
		scheduleSave();
		const start = pageAt(viewport.scrollTop);
		const end = pageAt(viewport.scrollTop + viewport.clientHeight);
		const nearby = [current];
		for (let index = start; index <= end && nearby.length < MAX_RENDERED_PAGES; index++) {
			if (index !== current) nearby.push(index);
		}
		if (end + 1 < slots.length && nearby.length < MAX_RENDERED_PAGES) nearby.push(end + 1);
		if (start > 0 && nearby.length < MAX_RENDERED_PAGES) nearby.push(start - 1);
		wanted = nearby;
		for (const [index, entry] of rendered) {
			if (wanted.includes(index)) continue;
			releaseCanvas(entry.canvas);
			rendered.delete(index);
		}
		if (active) {
			if (!wanted.includes(active.index)) active.task?.cancel();
			return;
		}
		if (pinching) return;
		const displayWidth = pageWidth();
		const index = wanted.find((page) => !slots[page].failed && rendered.get(page)?.displayWidth !== displayWidth);
		if (index !== undefined) void renderPage(index, documentPdf);
	}
	function schedule(): void {
		if (closed || failed || frame !== undefined) return;
		frame = win.requestAnimationFrame(refresh);
	}
	const resize = () => {
		const width = viewport.clientWidth;
		if (!slots.length || !width || !viewport.clientHeight) return;
		if (!layoutWidth) {
			layoutWidth = width;
			stack.setCssProps({ width: pageWidth() + 'px' });
			viewport.scrollTop = slots[current].element.offsetTop;
			lastScrollTop = viewport.scrollTop;
		} else if (width !== layoutWidth) {
			updateCurrent();
			const anchor = captureAnchor(viewport.scrollTop);
			const relativeLeft = viewport.scrollLeft / layoutWidth;
			layoutWidth = width;
			stack.setCssProps({ width: pageWidth() + 'px' });
			viewport.scrollLeft = relativeLeft * layoutWidth;
			restoreAnchor(anchor, 0);
		}
		schedule();
	};
	const resizeObserver = new ResizeObserver(resize);
	resizeObserver.observe(viewport);
	viewport.addEventListener('scroll', schedule, { passive: true });

	const removePinch = attachPreviewPinch(viewport, () => zoom, (scale, center, previousCenter) => {
		if (!slots.length || !layoutWidth) return;
		pinching = true;
		if (saveTimer !== undefined) win.clearTimeout(saveTimer);
		saveTimer = undefined;
		updateCurrent();
		const anchor = captureAnchor(viewport.scrollTop + previousCenter.y);
		const relativeX = (viewport.scrollLeft + previousCenter.x) / zoom;
		zoom = scale;
		stack.setCssProps({ width: pageWidth() + 'px' });
		viewport.scrollLeft = relativeX * zoom - center.x;
		restoreAnchor(anchor, center.y);
		schedule();
	}, () => {
		pinching = false;
		schedule();
	});

	void (async () => {
		try {
			const pdf = await loadPdfJs() as PdfLibrary;
			if (closed) return;
			// PDF.js may transfer the input buffer to its worker.
			loadingTask = pdf.getDocument({ data: bytes.slice(), isEvalSupported: false });
			documentPdf = await loadingTask.promise;
			if (closed) return;
			const requested = initialPosition?.page ?? 1;
			current = Number.isSafeInteger(requested) ? Math.min(documentPdf.numPages, Math.max(1, requested)) - 1 : 0;
			const firstPage = await documentPdf.getPage(current + 1);
			if (closed) return;
			const aspect = pdfPageAspect(firstPage.getViewport({ scale: 1 }));
			firstPage.cleanup();
			const fragment = container.doc.adoptNode(createFragment());
			for (let index = 0; index < documentPdf.numPages; index++) {
				const element = fragment.createDiv({ cls: 'quark-pdf-page', attr: {
					role: 'img', 'aria-label': label('第 ' + (index + 1) + ' 页', 'Page ' + (index + 1)),
				} });
				element.setCssProps({ '--quark-pdf-page-aspect': String(aspect) });
				slots.push({ element, aspect });
			}
			stack.appendChild(fragment);
			count.hidden = false;
			showPageCount();
			resize();
		} catch {
			fail();
		}
	})();

	return () => {
		if (closed) return;
		if (painted && !failed) updateCurrent();
		savePosition();
		closed = true;
		if (!failed) stop();
	};
}
