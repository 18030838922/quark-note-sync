export type VaultFileKind = 'notes' | 'images' | 'documents' | 'media' | 'other';

export interface VaultUsage {
	totalBytes: number;
	fileCount: number;
	byKind: Array<{ kind: VaultFileKind; bytes: number; count: number }>;
	largest: Array<{ path: string; bytes: number }>;
}

export interface VaultFileUsageInput {
	path: string;
	extension: string;
	stat: { size: number };
}

const KIND_ORDER: readonly VaultFileKind[] = ['notes', 'images', 'documents', 'media', 'other'];

const NOTE_EXTENSIONS = new Set(['canvas', 'md', 'markdown']);
const IMAGE_EXTENSIONS = new Set(['avif', 'bmp', 'gif', 'heic', 'heif', 'jpeg', 'jpg', 'png', 'svg', 'tif', 'tiff', 'webp']);
const DOCUMENT_EXTENSIONS = new Set(['csv', 'doc', 'docm', 'docx', 'epub', 'odf', 'odg', 'odp', 'ods', 'odt', 'pdf', 'ppt', 'pptm', 'pptx', 'rtf', 'txt', 'xls', 'xlsm', 'xlsx']);
const MEDIA_EXTENSIONS = new Set(['3gp', 'aac', 'aiff', 'avi', 'flac', 'm4a', 'm4v', 'mkv', 'mov', 'mp3', 'mp4', 'mpeg', 'mpg', 'ogg', 'opus', 'wav', 'webm', 'wma', 'wmv']);

function kindForExtension(extension: string): VaultFileKind {
	const normalized = extension.toLowerCase().replace(/^\./, '');
	if (NOTE_EXTENSIONS.has(normalized)) return 'notes';
	if (IMAGE_EXTENSIONS.has(normalized)) return 'images';
	if (DOCUMENT_EXTENSIONS.has(normalized)) return 'documents';
	if (MEDIA_EXTENSIONS.has(normalized)) return 'media';
	return 'other';
}

function validFileSize(size: number): number {
	return Number.isFinite(size) && size >= 0 ? size : 0;
}

export function summarizeVaultFiles(files: readonly VaultFileUsageInput[]): VaultUsage {
	const aggregates: Record<VaultFileKind, { bytes: number; count: number }> = {
		notes: { bytes: 0, count: 0 },
		images: { bytes: 0, count: 0 },
		documents: { bytes: 0, count: 0 },
		media: { bytes: 0, count: 0 },
		other: { bytes: 0, count: 0 },
	};
	let totalBytes = 0;
	const largestCandidates: Array<{ path: string; bytes: number }> = [];

	for (const file of files) {
		const bytes = validFileSize(file.stat?.size);
		const kind = kindForExtension(file.extension);
		aggregates[kind].count += 1;
		aggregates[kind].bytes += bytes;
		totalBytes += bytes;
		largestCandidates.push({ path: file.path, bytes });
	}

	largestCandidates.sort((left, right) => {
		if (left.bytes !== right.bytes) return left.bytes > right.bytes ? -1 : 1;
		if (left.path < right.path) return -1;
		if (left.path > right.path) return 1;
		return 0;
	});

	return {
		totalBytes,
		fileCount: files.length,
		byKind: KIND_ORDER.map((kind) => ({ kind, ...aggregates[kind] })),
		largest: largestCandidates.slice(0, 5),
	};
}
