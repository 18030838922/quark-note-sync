import { Modal, Notice, Setting, type App } from 'obsidian';
import { normalizeSyncScope, type ScopeSelection, type SyncScope } from './sync-scope.ts';

export class SyncScopeModal extends Modal {
	constructor(
		app: App,
		private readonly english: boolean,
		private readonly current: SyncScope,
		private readonly previewScope: (scope: SyncScope) => Promise<ScopeSelection | undefined>,
		private readonly saveScope: (scope: SyncScope) => Promise<boolean>,
	) {
		super(app);
	}

	onOpen(): void {
		const label = (english: string, chinese: string) => this.english ? english : chinese;
		this.setTitle(label('Sync scope for this device', '此设备的同步范围'));
		const content = this.contentEl;
		content.empty();
		content.createEl('p', { text: label(
			'Leave a field blank to allow everything in that category. Files outside the scope stay on this device and in Quark Drive.',
			'留空表示不限制该项。范围外的文件会保留在此设备和夸克网盘。',
		) });
		let folders = this.current.folders.join('\n');
		let extensions = this.current.extensions.join(', ');
		let size = this.current.maxBytes === null ? '' : String(this.current.maxBytes / (1024 * 1024));
		let approved: SyncScope | undefined;
		const results = content.createDiv();
		const invalidate = () => {
			approved = undefined;
			save.disabled = true;
			results.empty();
		};
		const folderRow = new Setting(content).setName(label('Include folders', '同步文件夹'))
			.setDesc(label('One vault-relative folder per line, including its subfolders.', '每行填写一个仓库相对路径，包含其子文件夹。'))
			.addTextArea((input) => input.setValue(folders).onChange((value) => { folders = value; invalidate(); }));
		const typeRow = new Setting(content).setName(label('File extensions', '文件扩展名'))
			.setDesc(label('Separate extensions with commas. Example: md, canvas, pdf.', '用逗号分隔，例如 md、canvas、pdf。'))
			.addText((input) => input.setValue(extensions).onChange((value) => { extensions = value; invalidate(); }));
		const sizeRow = new Setting(content).setName(label('Maximum file size (MiB)', '单文件同步上限（MiB）'))
			.addText((input) => input.setValue(size).onChange((value) => { size = value; invalidate(); }));
		content.append(results);
		const buttons = content.createDiv({ cls: 'modal-button-container' });
		const preview = buttons.createEl('button', { text: label('Preview scope', '预览范围') });
		const save = buttons.createEl('button', { text: label('Save scope', '保存范围'), cls: 'mod-cta' });
		save.disabled = true;
		const setBusy = (busy: boolean) => {
			for (const row of [folderRow, typeRow, sizeRow]) {
				for (const el of row.controlEl.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')) el.disabled = busy;
			}
			preview.disabled = busy;
			save.disabled = busy || !approved;
		};
		preview.addEventListener('click', () => void (async () => {
			invalidate();
			const maxBytes = size.trim() ? Math.round(Number(size) * (1024 * 1024)) : null;
			if (maxBytes !== null && (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)) {
				new Notice(label('Enter a positive file size in MiB.', '请输入大于零的 MiB 数值。'));
				return;
			}
			const rawFolders = folders.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
			const rawExtensions = extensions.split(/[,，\s]+/).filter(Boolean);
			if (rawFolders.some((folder) => !normalizeSyncScope({ folders: [folder] }).folders.length) ||
				rawExtensions.some((extension) => !normalizeSyncScope({ extensions: [extension] }).extensions.length)) {
				new Notice(label('Check your folder paths and file extensions.', '请检查文件夹路径和扩展名。'));
				return;
			}
			const draft = normalizeSyncScope({ folders: rawFolders, extensions: rawExtensions, maxBytes });
			setBusy(true);
			try {
				const selection = await this.previewScope(draft);
				if (!selection || !content.isConnected) return;
				results.createEl('p', { text: label(
					`Included: ${selection.included.length} · Outside scope: ${selection.excluded.length}`,
					`范围内：${selection.included.length} 个 · 范围外：${selection.excluded.length} 个`,
				) });
				for (const [heading, paths] of [[label('Included files', '范围内文件'), selection.included], [label('Outside scope', '范围外文件'), selection.excluded]] as const) {
					const details = results.createEl('details');
					details.createEl('summary', { text: heading });
					const list = details.createEl('ul', { cls: 'quark-history-list' });
					for (const path of paths.slice().sort().slice(0, 100)) list.createEl('li', { text: path });
					if (paths.length > 100) list.createEl('li', { text: label(`${paths.length - 100} more files`, `另有 ${paths.length - 100} 个文件`) });
				}
				approved = draft;
			} finally { setBusy(false); }
		})());
		save.addEventListener('click', () => void (async () => {
			if (!approved) return;
			setBusy(true);
			try {
				if (await this.saveScope(approved)) this.close();
			} finally { setBusy(false); }
		})());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
