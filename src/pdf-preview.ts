import { loadPdfJs } from 'obsidian';

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

export interface PdfReadingPosition {
	page: number;
	zoom: number;
}

const FIT_WIDTH = 1;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.25;

function pdfCanvasScale(width: number, height: number, displayWidth: number, pixelRatio: number): number {
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
		throw new Error('Invalid PDF viewport');
	}
	const target = displayWidth * Math.min(Math.max(pixelRatio, 1), 2) / width;
	return Math.min(target, 4096 / width, 4096 / height, Math.sqrt(4_000_000 / width / height));
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
	const toolbar = container.createDiv({ cls: 'quark-pdf-toolbar' });
	const pages = toolbar.createEl('form', { cls: 'quark-pdf-controls' });
	const previous = pages.createEl('button', {
		text: '‹', attr: { type: 'button', 'aria-label': label('上一页', 'Previous page') },
	});
	const pageInput = pages.createEl('input', {
		cls: 'quark-pdf-page-input',
		attr: { type: 'text', inputmode: 'numeric', enterkeyhint: 'go', 'aria-label': label('页码', 'Page number') },
	});
	const pageTotal = pages.createSpan();
	const jump = pages.createEl('button', { text: label('跳转', 'Go'), attr: { type: 'submit' } });
	const next = pages.createEl('button', {
		text: '›', attr: { type: 'button', 'aria-label': label('下一页', 'Next page') },
	});
	const zoomControls = toolbar.createDiv({ cls: 'quark-pdf-controls' });
	const zoomOut = zoomControls.createEl('button', {
		text: '−', attr: { type: 'button', 'aria-label': label('缩小', 'Zoom out') },
	});
	const fitWidthLabel = label('适合宽度', 'Fit width');
	const fitWidth = zoomControls.createEl('button', {
		text: fitWidthLabel, attr: { type: 'button', 'aria-label': fitWidthLabel },
	});
	const zoomIn = zoomControls.createEl('button', {
		text: '+', attr: { type: 'button', 'aria-label': label('放大', 'Zoom in') },
	});
	const zoomValue = zoomControls.createSpan({ cls: 'quark-pdf-zoom-value' });
	const status = toolbar.createSpan({ cls: 'quark-pdf-status', attr: { role: 'status' } });
	const viewport = container.createDiv({ cls: 'quark-pdf-viewport' });
	const canvas = viewport.createEl('canvas', { cls: 'quark-pdf-canvas', attr: { role: 'img' } });
	canvas.hidden = true;
	let closed = false;
	let position: PdfReadingPosition | undefined;
	let drawing = false;
	let renderedWidth = 0;
	let loadingTask: PdfLoadingTask | undefined;
	let renderTask: ReturnType<PdfPage['render']> | undefined;
	let documentPdf: PdfDocument | undefined;

	const updateControls = () => {
		const page = position?.page ?? 0;
		const zoom = position?.zoom ?? FIT_WIDTH;
		const ready = !drawing && Boolean(position);
		previous.disabled = !ready || page <= 1;
		next.disabled = !ready || page >= (documentPdf?.numPages ?? 0);
		pageInput.disabled = jump.disabled = !ready;
		zoomOut.disabled = fitWidth.disabled = !ready || zoom <= FIT_WIDTH;
		zoomIn.disabled = !ready || zoom >= MAX_ZOOM;
	};
	const loadingLabel = label('正在加载 PDF…', 'Loading PDF…');
	const setStatus = (text: string, visible: boolean) => {
		status.toggleClass('quark-pdf-status-visible', visible);
		status.setText(text);
	};
	const fail = () => {
		if (closed) return;
		canvas.hidden = true;
		canvas.width = canvas.height = 0;
		setStatus(label('无法渲染 PDF。文件可能已加密、损坏或不受支持。', 'Could not render this PDF. The file may be encrypted, damaged, or unsupported.'), true);
		if (!position) {
			pages.remove();
			zoomControls.remove();
			showFallback();
		}
	};

	const renderPage = async (requested: PdfReadingPosition): Promise<void> => {
		if (closed || drawing || !documentPdf) return;
		drawing = true;
		updateControls();
		const samePage = position?.page === requested.page;
		if (!samePage) setStatus(loadingLabel, !position);
		const positionChanged = !samePage || position?.zoom !== requested.zoom;
		const scrollTop = container.scrollTop;
		const oldHeight = canvas.clientHeight;
		const oldWidth = canvas.clientWidth;
		const horizontalCenter = oldWidth ? (viewport.scrollLeft + viewport.clientWidth / 2) / oldWidth : 0.5;
		let page: PdfPage | undefined;
		let succeeded = false;
		try {
			page = await documentPdf.getPage(requested.page);
			if (closed) return;
			const base = page.getViewport({ scale: 1 });
			renderedWidth = viewport.clientWidth;
			const displayWidth = (renderedWidth || 600) * requested.zoom;
			const scale = pdfCanvasScale(base.width, base.height, displayWidth, container.win.devicePixelRatio);
			const pageViewport = page.getViewport({ scale });
			canvas.width = Math.max(1, Math.floor(pageViewport.width));
			canvas.height = Math.max(1, Math.floor(pageViewport.height));
			const context = canvas.getContext('2d', { alpha: false });
			if (!context) throw new Error('PDF canvas is unavailable');
			renderTask = page.render({ canvas, canvasContext: context, viewport: pageViewport });
			await renderTask.promise;
			if (closed) return;
			position = requested;
			canvas.style.width = `${requested.zoom * 100}%`;
			canvas.hidden = false;
			const pageLabel = label(`第 ${requested.page} / ${documentPdf.numPages} 页`, `Page ${requested.page} of ${documentPdf.numPages}`);
			canvas.setAttr('aria-label', pageLabel);
			pageInput.value = String(requested.page);
			zoomValue.setText(`${Math.round(requested.zoom * 100)}%`);
			setStatus(pageLabel, false);
			container.scrollTop = samePage && oldHeight ? scrollTop * canvas.clientHeight / oldHeight : 0;
			viewport.scrollLeft = samePage ? horizontalCenter * canvas.clientWidth - viewport.clientWidth / 2 : 0;
			succeeded = true;
		} catch {
			fail();
		} finally {
			renderTask = undefined;
			drawing = false;
			if (!closed) {
				page?.cleanup();
				updateControls();
			}
		}
		if (succeeded && !closed) {
			if (positionChanged) onPositionChange?.(requested);
			refreshSize();
		}
	};

	const refreshSize = () => {
		const width = viewport.clientWidth;
		if (position && !canvas.hidden && width > 0 && width !== renderedWidth) void renderPage(position);
	};
	const resizeObserver = new ResizeObserver(refreshSize);
	resizeObserver.observe(viewport);
	const goToPage = (pageNumber: number) => {
		if (!position || !documentPdf || drawing) return;
		if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > documentPdf.numPages) {
			setStatus(label(`请输入 1 至 ${documentPdf.numPages} 的页码。`, `Enter a page from 1 to ${documentPdf.numPages}.`), true);
			return;
		}
		void renderPage({ ...position, page: pageNumber });
	};
	previous.addEventListener('click', () => { if (position) goToPage(position.page - 1); });
	next.addEventListener('click', () => { if (position) goToPage(position.page + 1); });
	pages.addEventListener('submit', (event) => {
		event.preventDefault();
		const input = pageInput.value.trim();
		goToPage(/^\d+$/.test(input) ? Number(input) : NaN);
		pageInput.blur();
	});
	zoomIn.addEventListener('click', () => {
		if (position) void renderPage({ ...position, zoom: Math.min(MAX_ZOOM, position.zoom + ZOOM_STEP) });
	});
	zoomOut.addEventListener('click', () => {
		if (position) void renderPage({ ...position, zoom: Math.max(FIT_WIDTH, position.zoom - ZOOM_STEP) });
	});
	fitWidth.addEventListener('click', () => {
		if (position) void renderPage({ ...position, zoom: FIT_WIDTH });
	});
	updateControls();
	setStatus(loadingLabel, true);
	void (async () => {
		try {
			const pdf = await loadPdfJs() as PdfLibrary;
			if (closed) return;
			// PDF.js may transfer the input buffer to its worker. Preserve the preview's original bytes.
			loadingTask = pdf.getDocument({ data: bytes.slice(), isEvalSupported: false });
			documentPdf = await loadingTask.promise;
			if (closed) return;
			pageTotal.setText(`/ ${documentPdf.numPages}`);
			const page = initialPosition?.page ?? 1;
			const zoom = initialPosition?.zoom ?? FIT_WIDTH;
			await renderPage({
				page: Number.isSafeInteger(page) ? Math.min(documentPdf.numPages, Math.max(1, page)) : 1,
				zoom: Number.isFinite(zoom) ? Math.min(MAX_ZOOM, Math.max(FIT_WIDTH, zoom)) : FIT_WIDTH,
			});
		} catch {
			fail();
		}
	})();

	return () => {
		closed = true;
		resizeObserver.disconnect();
		renderTask?.cancel();
		if (loadingTask) void loadingTask.destroy().catch(() => {});
		canvas.width = canvas.height = 0;
	};
}
