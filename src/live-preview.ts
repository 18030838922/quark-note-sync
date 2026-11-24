import { editorLivePreviewField } from 'obsidian';
import type { Extension } from '@codemirror/state';
import { Decoration, ViewPlugin, WidgetType, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view';
import { findOfficialShareLinks, findPersonalReferenceLinks, type OfficialShareLinkRange, type PersonalReference, type PersonalReferenceLinkRange } from './quark-references.ts';
import type { PreviewPayload } from './source-browser.ts';

type ReferenceRange = PersonalReferenceLinkRange | OfficialShareLinkRange;

export interface ReferenceLivePreviewOptions {
	language(): 'zh-CN' | 'en';
	openReference(reference: PersonalReference, showMedia: (payload: PreviewPayload) => void): Promise<void>;
	openShare(rawUrl: string, showMedia: (payload: PreviewPayload) => void): Promise<void>;
	reportError(error: unknown): void;
}

export function createReferenceLivePreview(options: ReferenceLivePreviewOptions): Extension {
	class ReferenceWidget extends WidgetType {
		private objectUrl: string | undefined;

		constructor(
			private readonly range: ReferenceRange,
			private readonly actions: ReferenceLivePreviewOptions,
		) {
			super();
		}

		toDOM(view: EditorView): HTMLElement {
			const doc = view.dom.ownerDocument;
			const root = doc.createElement('span');
			root.className = 'quark-live-reference';
			const button = doc.createElement('button');
			button.type = 'button';
			button.className = 'quark-live-reference-button';
			button.textContent = this.range.label || this.label('夸克文件', 'Quark file');
			button.setAttribute('aria-label', this.label(`打开夸克文件：${button.textContent}`, `Open Quark file: ${button.textContent}`));
			button.title = this.label('点击打开；图片和音视频会在此处按需加载。', 'Click to open; images and audio/video load here on demand.');
			button.addEventListener('click', (event) => {
				event.preventDefault();
				event.stopPropagation();
				button.disabled = true;
				const showMedia = (payload: PreviewPayload) => {
					if (!root.isConnected) return;
					this.renderMedia(root, payload, view);
				};
				const open = 'rawUrl' in this.range
					? this.actions.openShare(this.range.rawUrl, showMedia)
					: this.actions.openReference(this.range.reference, showMedia);
				void open.then(() => {
					if (button.isConnected) button.disabled = false;
				}).catch((error: unknown) => {
					if (button.isConnected) button.disabled = false;
					this.actions.reportError(error);
				});
			});
			root.append(button);
			return root;
		}

		eq(other: WidgetType): boolean {
			if (!(other instanceof ReferenceWidget)) return false;
			return this.range.from === other.range.from && this.range.to === other.range.to &&
				this.range.label === other.range.label && this.range.embedded === other.range.embedded &&
				rangeKey(this.range) === rangeKey(other.range);
		}

		ignoreEvent(): boolean {
			return true;
		}

		destroy(): void {
			if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
			this.objectUrl = undefined;
		}

		private renderMedia(root: HTMLElement, payload: PreviewPayload, view: EditorView): void {
			if (!payload.bytes || !payload.mimeType || !['image', 'audio', 'video'].includes(payload.kind)) return;
			if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
			const buffer = payload.bytes.buffer.slice(payload.bytes.byteOffset, payload.bytes.byteOffset + payload.bytes.byteLength) as ArrayBuffer;
			this.objectUrl = URL.createObjectURL(new Blob([buffer], { type: payload.mimeType }));
			root.replaceChildren();
			if (payload.kind === 'image') {
				const image = root.ownerDocument.createElement('img');
				image.className = 'quark-inline-media-image';
				image.alt = payload.name;
				image.src = this.objectUrl;
				root.append(image);
			} else {
				const media = root.ownerDocument.createElement(payload.kind) as HTMLAudioElement | HTMLVideoElement;
				media.className = `quark-inline-media-${payload.kind}`;
				media.controls = true;
				media.preload = 'none';
				media.src = this.objectUrl;
				root.append(media);
			}
			view.requestMeasure();
		}

		private label(chinese: string, english: string): string {
			return this.actions.language() === 'en' ? english : chinese;
		}
	}

	function decorations(view: EditorView): DecorationSet {
		if (!view.state.field(editorLivePreviewField, false)) return Decoration.none;
		const text = view.state.doc.toString();
		const cursorPositions = view.state.selection.ranges.map((range) => range.head);
		const ranges = [...findPersonalReferenceLinks(text), ...findOfficialShareLinks(text)]
			.filter((range) => !cursorPositions.some((position) => position >= range.from && position <= range.to))
			.map((range) => Decoration.replace({
				widget: new ReferenceWidget(range, options),
				inclusive: true,
			}).range(range.from, range.to));
		return Decoration.set(ranges, true);
	}

	return ViewPlugin.fromClass(class {
		decorations: DecorationSet;

		constructor(view: EditorView) {
			this.decorations = decorations(view);
		}

		update(update: ViewUpdate): void {
			const wasLivePreview = update.startState.field(editorLivePreviewField, false);
			const isLivePreview = update.state.field(editorLivePreviewField, false);
			if (update.docChanged || update.selectionSet || wasLivePreview !== isLivePreview) this.decorations = decorations(update.view);
		}
	}, { decorations: (plugin) => plugin.decorations });
}

function rangeKey(range: ReferenceRange): string {
	return 'rawUrl' in range ? range.rawUrl : `${range.reference.accountKey}/${range.reference.fid}`;
}
