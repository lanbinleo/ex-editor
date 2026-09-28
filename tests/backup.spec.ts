import { describe, expect, it } from 'vitest';
import { backupFilePath, backupFolder, parseBackupReason } from '../src/storage/backup';

describe('backup 路径纯函数', () => {
	it('快照目录镜像 vault 目录结构', () => {
		expect(backupFolder('.exeditor/backups', '笔记.md')).toBe('.exeditor/backups');
		expect(backupFolder('.exeditor/backups', '日记/2026/九月.md')).toBe(
			'.exeditor/backups/日记/2026',
		);
	});

	it('目录尾斜杠被归一化', () => {
		expect(backupFolder('.exeditor/backups/', 'a/b.md')).toBe('.exeditor/backups/a');
	});

	it('快照文件名含 基名--时间戳-原因.md', () => {
		const p = backupFilePath('.exeditor/backups', '日记/九月.md', 'rewrite');
		expect(p).toMatch(/^\.exeditor\/backups\/日记\/九月--\d{8}-\d{6}-rewrite\.md$/);
	});

	it('解析快照原因', () => {
		expect(parseBackupReason('九月--20260928-153045-accept.md')).toBe('accept');
		expect(parseBackupReason('九月--20260928-153045-manual.md')).toBe('manual');
		expect(parseBackupReason('随便什么.md')).toBe('unknown');
	});
});
