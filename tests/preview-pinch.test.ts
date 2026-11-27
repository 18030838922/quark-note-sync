import assert from 'node:assert/strict';
import test from 'node:test';
import { attachPreviewPinch, createMobileMediaSurface } from '../src/preview-pinch.ts';

const finger = (identifier: number, clientX: number, clientY: number) => ({ identifier, clientX, clientY });
type Finger = ReturnType<typeof finger>;

function viewport() {
	return Object.assign(new EventTarget(), { getBoundingClientRect: () => ({ left: 10, top: 20 }) }) as unknown as HTMLElement;
}

function touch(target: HTMLElement, type: string, touches: Finger[]) {
	const event = new Event(type, { cancelable: true });
	Object.defineProperty(event, 'touches', { value: touches });
	target.dispatchEvent(event);
	return event;
}

test('pinch follows touch identifiers and the midpoint while leaving a single-finger scroll unhandled', () => {
	const target = viewport();
	const updates: unknown[] = [];
	let finishes = 0;
	const dispose = attachPreviewPinch(target, () => 1, (zoom, center, previousCenter) =>
		updates.push({ zoom, center, previousCenter }), () => { finishes += 1; });

	assert.equal(touch(target, 'touchstart', [finger(1, 10, 40)]).defaultPrevented, false);
	assert.equal(touch(target, 'touchmove', [finger(1, 10, 60)]).defaultPrevented, false);
	assert.equal(touch(target, 'touchstart', [finger(1, 10, 40), finger(2, 30, 40)]).defaultPrevented, true);
	assert.equal(touch(target, 'touchmove', [finger(2, 55, 70), finger(1, 15, 70)]).defaultPrevented, true);
	assert.deepEqual(updates, [{ zoom: 2, center: { x: 25, y: 50 }, previousCenter: { x: 10, y: 20 } }]);
	touch(target, 'touchend', [finger(1, 15, 70)]);
	assert.equal(finishes, 1);
	dispose();
	assert.equal(touch(target, 'touchstart', [finger(1, 10, 40), finger(2, 30, 40)]).defaultPrevented, false);
});

test('pinch clamps the scale and allows a new gesture after cancellation', () => {
	const target = viewport();
	const updates: number[] = [];
	let finishes = 0;
	const detach = attachPreviewPinch(target, () => 1.5, (zoom) => updates.push(zoom), () => { finishes += 1; });
	touch(target, 'touchstart', [finger(1, 0, 0), finger(2, 20, 0)]);
	touch(target, 'touchmove', [finger(1, 0, 0), finger(2, 100, 0)]);
	touch(target, 'touchmove', [finger(1, 0, 0), finger(2, 5, 0)]);
	touch(target, 'touchcancel', [finger(1, 0, 0), finger(2, 5, 0)]);
	touch(target, 'touchstart', [finger(3, 0, 0), finger(4, 30, 0)]);
	touch(target, 'touchmove', [finger(3, 0, 0), finger(4, 36, 0)]);
	assert.equal(finishes, 1);
	assert.deepEqual(updates, [3, 1, 1.8]);
	detach();
});


test('media surfaces reserve continuous scrolling space and keep the touched point centered while zooming', () => {
	const host = viewport();
	const rect = { left: 10, top: 20 };
	const viewportStyle = { paddingLeft: '20px', paddingRight: '20px' };
	let sizeChanged: ResizeObserverCallback | undefined;
	let disconnected = false;
	const previousObserver = globalThis.ResizeObserver;
	class Observer {
		constructor(callback: ResizeObserverCallback) { sizeChanged = callback; }
		observe() {}
		disconnect() { disconnected = true; }
	}
	const contentStyle: Record<string, string> = {};
	const stageStyle: Record<string, string> = {};
	const content = {
		offsetHeight: 1200,
		setCssProps: (values: Record<string, string>) => Object.assign(contentStyle, values),
	};
	const stage = {
		createDiv: () => content,
		setCssProps: (values: Record<string, string>) => Object.assign(stageStyle, values),
		getBoundingClientRect: () => ({ left: rect.left + 20 - host.scrollLeft, top: rect.top + 60 - host.scrollTop }),
	};
	Object.assign(host, {
		clientWidth: 340,
		scrollTop: 100,
		scrollLeft: 0,
		win: { getComputedStyle: () => viewportStyle },
		createDiv: () => stage,
	});
	globalThis.ResizeObserver = Observer as unknown as typeof ResizeObserver;
	try {
		const surface = createMobileMediaSurface(host);
		assert.equal(surface.content, content);
		assert.deepEqual(stageStyle, { width: '300px', height: '1200px' });
		touch(host, 'touchstart', [finger(1, 120, 140), finger(2, 200, 140)]);
		touch(host, 'touchmove', [finger(1, 80, 140), finger(2, 240, 140)]);
		assert.equal(contentStyle['--quark-preview-scale'], '2');
		assert.deepEqual(stageStyle, { width: '600px', height: '2400px' });
		assert.equal(host.scrollTop, 260);
		assert.equal(host.scrollLeft, 130);

		Object.assign(host, { clientWidth: 440 });
		content.offsetHeight = 1000;
		sizeChanged?.([], {} as ResizeObserver);
		assert.deepEqual(stageStyle, { width: '800px', height: '2000px' });
		surface.dispose();
		assert.equal(disconnected, true);
	} finally {
		globalThis.ResizeObserver = previousObserver;
	}
});
