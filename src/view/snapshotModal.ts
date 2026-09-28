import { Modal } from 'obsidian';
import type { App } from 'obsidian';
import type ExEditorPlugin from '../main';
import { listBackups } from '../storage/backup';
import type { BackupInfo } from '../storage/backup';
import { formatClock } from '../util';

const BACKUP_REASON_LABELS: Record<string, string> = {
	accept: '接受前',
	rewrite: '改写前',
	restore: '恢复前',
	manual: '手动',
	check: '检查前',
	unknown: '快照',
};

/** 快照与恢复：命令面板打开的模态框（不占用侧边栏空间） */
export class SnapshotModal extends Modal {
	constructor(app: App, private plugin: ExEditorPlugin) {
		super(app);
	}

	async onOpen(): Promise<void> {
		this.titleEl.setText('快照与恢复');
		await this.renderList();
	}

	private async renderList(): Promise<void> {
		const content = this.contentEl;
		content.empty();
		content.addClass('ex-snap');
		const ctx = this.plugin.resolver.resolve();
		if (!ctx) {
			content.createDiv({ cls: 'ex-hint', text: '请先打开一篇文档' });
			return;
		}
		const toolbar = content.createDiv({ cls: 'ex-snap-toolbar' });
		const backupBtn = toolbar.createEl('button', { text: '立即备份当前内容' });
		backupBtn.addEventListener('click', () =>
			void this.plugin.backupActiveFile().then(() => this.renderList()),
		);

		let backups: BackupInfo[] = [];
		try {
			backups = await listBackups(this.app, this.plugin.settings.backupDir, ctx.file);
		} catch {
			backups = [];
		}
		if (!backups.length) {
			content.createDiv({
				cls: 'ex-hint',
				text: '暂无快照。批量接受与改写应用前会自动备份。',
			});
			return;
		}
		const list = content.createDiv({ cls: 'ex-snap-list' });
		for (const bp of backups) {
			const row = list.createDiv({ cls: 'ex-snap-row' });
			row.createSpan({
				cls: 'ex-snap-time',
				text: `${formatClock(bp.mtime)} · ${BACKUP_REASON_LABELS[bp.reason] ?? '快照'}`,
			});
			const restore = row.createEl('button', { text: '恢复' });
			restore.addEventListener('click', () =>
				void this.plugin.restoreBackup(bp.path).then(() => this.close()),
			);
		}
	}
}
