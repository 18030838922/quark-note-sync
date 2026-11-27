export interface PreviewPoint {
	x: number;
	y: number;
}

type ZoomUpdate = (zoom: number, center: PreviewPoint, previousCenter: PreviewPoint) => void;

interface Pinch {
	first: number;
	second: number;
	distance: number;
	zoom: number;
	center: PreviewPoint;
}

function centerOf(first: Touch, second: Touch, rect: DOMRect): PreviewPoint {
	return { x: (first.clientX + second.clientX) / 2 - rect.left, y: (first.clientY + second.clientY) / 2 - rect.top };
}

function distanceBetween(first: Touch, second: Touch): number {
	return Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
}

/** Native scrolling uses one finger. Two fingers zoom around the touched content. */
export function attachPreviewPinch(
	viewport: HTMLElement,
	getZoom: () => number,
	update: ZoomUpdate,
	onEnd?: () => void,
): () => void {
	let pinch: Pinch | undefined;

	const start = (event: TouchEvent) => {
		if (pinch || event.touches.length < 2) return;
		const [first, second] = Array.from(event.touches);
		const distance = distanceBetween(first, second);
		if (distance < 8) return;
		event.preventDefault();
		event.stopPropagation();
		pinch = {
			first: first.identifier,
			second: second.identifier,
			distance,
			zoom: getZoom(),
			center: centerOf(first, second, viewport.getBoundingClientRect()),
		};
	};
	const move = (event: TouchEvent) => {
		if (!pinch) start(event);
		if (!pinch) return;
		const active = pinch;
		const touches = Array.from(event.touches);
		const first = touches.find((touch) => touch.identifier === active.first);
		const second = touches.find((touch) => touch.identifier === active.second);
		if (!first || !second) return;
		event.preventDefault();
		event.stopPropagation();
		const zoom = Math.min(3, Math.max(1, active.zoom * distanceBetween(first, second) / active.distance));
		const center = centerOf(first, second, viewport.getBoundingClientRect());
		update(zoom, center, active.center);
		active.center = center;
	};
	const finish = () => {
		if (!pinch) return;
		pinch = undefined;
		onEnd?.();
	};

	const end = (event: TouchEvent) => {
		if (!pinch) return;
		const active = pinch;
		const touches = Array.from(event.touches);
		if (touches.some((touch) => touch.identifier === active.first) &&
			touches.some((touch) => touch.identifier === active.second)) return;
		finish();
	};

	viewport.addEventListener('touchstart', start, { passive: false });
	viewport.addEventListener('touchmove', move, { passive: false });
	viewport.addEventListener('touchend', end);
	viewport.addEventListener('touchcancel', finish);
	return () => {
		pinch = undefined;
		viewport.removeEventListener('touchstart', start);
		viewport.removeEventListener('touchmove', move);
		viewport.removeEventListener('touchend', end);
		viewport.removeEventListener('touchcancel', finish);
	};
}

export interface MobileMediaSurface {
	content: HTMLElement;
	dispose(): void;
}

/** Reserve the transformed dimensions so the surrounding viewport can scroll normally. */
export function createMobileMediaSurface(viewport: HTMLElement): MobileMediaSurface {
	const stage = viewport.createDiv({ cls: 'quark-mobile-media-stage' });
	const content = stage.createDiv({ cls: 'quark-mobile-media-content' });
	let zoom = 1;

	const resize = () => {
		if (!viewport.clientWidth) return;
		const styles = viewport.win.getComputedStyle(viewport);
		const width = Math.max(1, viewport.clientWidth - (parseFloat(styles.paddingLeft) || 0) - (parseFloat(styles.paddingRight) || 0));
		content.setCssProps({ width: `${width}px` });
		stage.setCssProps({
			width: `${width * zoom}px`,
			height: `${content.offsetHeight * zoom}px`,
		});
	};
	resize();
	const observer = new ResizeObserver(resize);
	observer.observe(viewport);
	observer.observe(content);
	const detach = attachPreviewPinch(viewport, () => zoom, (next, center, previousCenter) => {
		const frame = viewport.getBoundingClientRect();
		const bounds = stage.getBoundingClientRect();
		const x = bounds.left - frame.left;
		const y = bounds.top - frame.top;
		const ratio = next / zoom;
		const left = viewport.scrollLeft + x + (previousCenter.x - x) * ratio - center.x;
		const top = viewport.scrollTop + y + (previousCenter.y - y) * ratio - center.y;
		zoom = next;
		content.setCssProps({ '--quark-preview-scale': String(zoom) });
		resize();
		viewport.scrollLeft = left;
		viewport.scrollTop = top;
	});
	return {
		content,
		dispose: () => {
			detach();
			observer.disconnect();
		},
	};
}
