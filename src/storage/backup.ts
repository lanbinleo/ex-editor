import type { App, TFile } from 'obsidian';
import { timestampStamp } from '../util';

export interface BackupInfo {
	/** vault 内完整路径 */
	path: string;
	mtime: number;
	/** check / accept / rewrite / restore / manual */
	reason: string;
}

export const BACKUP_REASONS = ['check', 'accept', 'rewrite', 'restore', 'manual'] as const;
export type BackupReason = (typeof BACKUP_REASONS)[number];

/** 一篇笔记的快照目录：镜像 vault 目录结构，避免同名笔记冲突（纯函数） */
export function backupFolder(backupDir: string, filePath: string): string {
	const dir = backupDir.replace(/\/+$/, '') || '.exeditor/backups';
	const fileDir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
	return fileDir ? `${dir}/${fileDir}` : dir;
}

/** 单个快照文件的完整路径（纯函数） */
export function backupFilePath(backupDir: string, filePath: string, reason: string): string {
	const base = filePath.slice(filePath.lastIndexOf('/') + 1).replace(/\.md$/i, '');
	return `${backupFolder(backupDir, filePath)}/${base}--${timestampStamp()}-${reason}.md`;
}

/** 从快照文件名解析 reason；无法解析返回 unknown */
export function parseBackupReason(fileName: string): string {
	const m = /--\d{8}-\d{6}-([a-z]+)\.md$/i.exec(fileName);
	const reason = m?.[1] ?? 'unknown';
	return (BACKUP_REASONS as readonly string[]).includes(reason) ? reason : 'unknown';
}

async function ensureFolder(app: App, folder: string): Promise<void> {
	const existing = app.vault.getAbstractFileByPath(folder);
	if (existing) return;
	await app.vault.createFolder(folder).catch(() => {
		/* 并发创建冲突时忽略，下一次写入会失败并报错 */
	});
}

/** 写入当前文件内容的快照；失败返回 null（不中断主流程） */
export async function createBackup(
	app: App,
	backupDir: string,
	backupKeep: number,
	file: TFile,
	reason: BackupReason,
): Promise<string | null> {
	try {
		const content = await app.vault.read(file);
		const folder = backupFolder(backupDir, file.path);
		await ensureFolder(app, folder);
		const path = backupFilePath(backupDir, file.path, reason);
		await app.vault.create(path, content);
		await pruneBackups(app, folder, file, backupKeep);
		return path;
	} catch (e) {
		console.error('ExEditor 快照失败', e);
		return null;
	}
}

/** 超出保留上限时删除最旧的快照（按文件名中的时间戳排序） */
async function pruneBackups(
	app: App,
	folder: string,
	file: TFile,
	keep: number,
): Promise<void> {
	const base = file.name.replace(/\.md$/i, '');
	const listing = await app.vault.adapter.list(folder);
	const snaps = listing.files
		.filter((f) => f.includes(`/${base}--`) && f.endsWith('.md'))
		.sort()
		.reverse();
	for (const old of snaps.slice(keep)) {
		await app.vault.adapter.remove(old).catch(() => {
			/* 删除失败不影响主流程 */
		});
	}
}

/** 列出一篇笔记的全部快照，新→旧 */
export async function listBackups(
	app: App,
	backupDir: string,
	file: TFile,
): Promise<BackupInfo[]> {
	const folder = backupFolder(backupDir, file.path);
	const listing = await app.vault.adapter.list(folder).catch(() => null);
	if (!listing) return [];
	const base = file.name.replace(/\.md$/i, '');
	const out: BackupInfo[] = [];
	for (const f of listing.files) {
		const name = f.slice(f.lastIndexOf('/') + 1);
		if (!name.startsWith(`${base}--`) || !name.endsWith('.md')) continue;
		// getFileByPath 直接返回 TFile | null，避免引入 instanceof 依赖
		const snap = app.vault.getFileByPath(f);
		if (!snap) continue;
		out.push({ path: f, mtime: snap.stat.mtime, reason: parseBackupReason(name) });
	}
	return out.sort((a, b) => b.mtime - a.mtime);
}

export async function readBackup(app: App, backupPath: string): Promise<string> {
	const file = app.vault.getFileByPath(backupPath);
	if (!file) throw new Error('快照文件不存在');
	return app.vault.read(file);
}
