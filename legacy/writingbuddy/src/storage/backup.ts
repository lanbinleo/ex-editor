import { App, TFile } from 'obsidian';
import type { WBSettings } from '../types';
import { timestampStamp } from '../util';

export interface BackupInfo {
  path: string;
  name: string;
  mtime: number;
  /** 从文件名解析出的原因：check / accept / rewrite / restore / manual */
  reason: string;
}

const REASONS = ['check', 'accept', 'rewrite', 'restore', 'manual'];

/** 某篇笔记的备份目录：{backupDir}/{所在文件夹}/{笔记名}/ */
function backupDirFor(settings: WBSettings, file: TFile): string {
  const base = (settings.backupDir || '.writing-buddy/backups').replace(/^\/+|\/+$/g, '');
  const parent = file.parent && file.parent.path && file.parent.path !== '/' ? file.parent.path : '';
  return parent ? `${base}/${parent}/${file.basename}` : `${base}/${file.basename}`;
}

async function ensureDir(app: App, dir: string): Promise<void> {
  const parts = dir.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    try {
      await app.vault.adapter.mkdir(current);
    } catch {
      // 已存在等情况，忽略
    }
  }
}

/** 创建快照，返回目标路径；失败返回 null */
export async function createBackup(
  app: App,
  settings: WBSettings,
  file: TFile,
  reason: string,
): Promise<string | null> {
  try {
    const safeReason = REASONS.includes(reason) ? reason : 'manual';
    const dir = backupDirFor(settings, file);
    await ensureDir(app, dir);
    const content = await app.vault.cachedRead(file);
    const target = `${dir}/${timestampStamp()}-${safeReason}.md`;
    await app.vault.adapter.write(target, content);
    await pruneBackups(app, settings, file);
    return target;
  } catch (e) {
    console.error('[编辑建议] 创建备份失败', e);
    return null;
  }
}

/** 每篇只保留最新 backupKeep 份 */
async function pruneBackups(app: App, settings: WBSettings, file: TFile): Promise<void> {
  const dir = backupDirFor(settings, file);
  let listing;
  try {
    listing = await app.vault.adapter.list(dir);
  } catch {
    return;
  }
  const files = listing.files
    .map((f) => f)
    .sort()
    .reverse(); // 时间戳命名，字典序即时间序
  const keep = Math.max(1, settings.backupKeep);
  for (const path of files.slice(keep)) {
    try {
      await (app.vault.adapter as unknown as { rm?: (p: string) => Promise<void> }).rm?.(path);
    } catch {
      try {
        await app.vault.adapter.trashLocal(path);
      } catch {
        // 清理失败不影响主流程
      }
    }
  }
}

/** 列出某篇笔记的全部快照（新→旧） */
export async function listBackups(
  app: App,
  settings: WBSettings,
  file: TFile,
): Promise<BackupInfo[]> {
  const dir = backupDirFor(settings, file);
  let listing;
  try {
    listing = await app.vault.adapter.list(dir);
  } catch {
    return [];
  }
  const out: BackupInfo[] = [];
  for (const path of listing.files.sort().reverse()) {
    const name = path.split('/').pop() ?? path;
    const reason = REASONS.find((r) => name.includes(`-${r}.md`)) ?? '';
    let mtime = 0;
    try {
      const stat = await app.vault.adapter.stat(path);
      mtime = stat?.mtime ?? 0;
    } catch {
      // 忽略
    }
    out.push({ path, name, mtime, reason });
  }
  return out;
}

export async function readBackup(app: App, backupPath: string): Promise<string> {
  return app.vault.adapter.read(backupPath);
}
