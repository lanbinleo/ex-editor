import type { Plugin } from 'obsidian';
import type { FileCheckState, StoreData, Suggestion, UsageTotals, WBSettings } from '../types';
import { todayKey } from '../util';
import { PRESETS } from '../settings';

export const DEFAULT_SETTINGS: WBSettings = {
  preset: 'deepseek',
  baseURL: PRESETS['deepseek'].baseURL,
  apiKey: '',
  model: PRESETS['deepseek'].model,
  reasoningMode: 'none',
  reasoningEffort: 'medium',
  maxTokens: 16384,
  temperature: 0,
  requestTimeoutSec: 300,
  useJsonMode: true,
  useRequestUrl: true,
  extraBody: '',
  backupDir: '.editing-suggestions/backups',
  backupKeep: 20,
  backupOnCheck: true,
  longDocThreshold: 30000,
};

function emptyUsage(): UsageTotals {
  return { requests: 0, promptTokens: 0, completionTokens: 0, byDay: {} };
}

/** 持久化上限：最多记住 50 篇文件、每篇 300 条建议 */
const MAX_FILES = 50;
const MAX_SUGGESTIONS_PER_FILE = 300;
const MAX_USAGE_DAYS = 14;

export class Store {
  public data: StoreData = { settings: { ...DEFAULT_SETTINGS }, usage: emptyUsage(), files: {} };
  private plugin: Plugin | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  async load(plugin: Plugin): Promise<void> {
    this.plugin = plugin;
    const raw = (await plugin.loadData()) as Partial<StoreData> | null;
    this.data = {
      settings: { ...DEFAULT_SETTINGS, ...(raw?.settings ?? {}) },
      usage: { ...emptyUsage(), ...(raw?.usage ?? {}) },
      files: raw?.files ?? {},
    };
  }

  /** 节流保存（accepted/ignored 状态不落盘，只保留 pending/stale） */
  queueSave(): void {
    if (!this.plugin) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      void this.plugin?.saveData(this.serialize());
    }, 800);
  }

  private serialize(): StoreData {
    const files: Record<string, FileCheckState> = {};
    const paths = Object.entries(this.data.files)
      .sort((a, b) => b[1].checkedAt - a[1].checkedAt)
      .slice(0, MAX_FILES);
    for (const [path, state] of paths) {
      files[path] = {
        contentHash: state.contentHash,
        checkedAt: state.checkedAt,
        suggestions: state.suggestions
          .filter((s) => s.status === 'pending' || s.status === 'stale')
          .slice(0, MAX_SUGGESTIONS_PER_FILE),
      };
    }
    const byDay: UsageTotals['byDay'] = {};
    const days = Object.keys(this.data.usage.byDay)
      .sort()
      .slice(-MAX_USAGE_DAYS);
    for (const day of days) byDay[day] = this.data.usage.byDay[day];
    return {
      settings: this.data.settings,
      usage: { ...this.data.usage, byDay },
      files,
    };
  }

  fileState(path: string): FileCheckState | undefined {
    return this.data.files[path];
  }

  ensureFileState(path: string): FileCheckState {
    let state = this.data.files[path];
    if (!state) {
      state = { suggestions: [], contentHash: '', checkedAt: 0 };
      this.data.files[path] = state;
    }
    return state;
  }

  getSuggestion(path: string, id: string): Suggestion | undefined {
    return this.data.files[path]?.suggestions.find((s) => s.id === id);
  }

  setStatus(path: string, id: string, status: Suggestion['status']): void {
    const sug = this.getSuggestion(path, id);
    if (sug) sug.status = status;
    this.queueSave();
  }

  /** 一次检查的结果落库：移除范围内旧建议，加入新建议 */
  commitCheckResult(
    path: string,
    removedIds: Set<string>,
    added: Suggestion[],
    contentHash: string,
  ): void {
    const state = this.ensureFileState(path);
    state.suggestions = state.suggestions.filter((s) => !removedIds.has(s.id));
    state.suggestions.push(...added);
    if (state.suggestions.length > MAX_SUGGESTIONS_PER_FILE) {
      state.suggestions = state.suggestions.slice(-MAX_SUGGESTIONS_PER_FILE);
    }
    state.contentHash = contentHash;
    state.checkedAt = Date.now();
    this.queueSave();
  }

  removeSuggestions(path: string, ids: Set<string>): void {
    const state = this.data.files[path];
    if (!state) return;
    state.suggestions = state.suggestions.filter((s) => !ids.has(s.id));
    this.queueSave();
  }

  setFileSuggestions(path: string, suggestions: Suggestion[], contentHash: string): void {
    const state = this.ensureFileState(path);
    state.suggestions = suggestions.slice(0, MAX_SUGGESTIONS_PER_FILE);
    state.contentHash = contentHash;
    this.queueSave();
  }

  addUsage(promptTokens: number, completionTokens: number): void {
    const usage = this.data.usage;
    usage.requests += 1;
    usage.promptTokens += promptTokens;
    usage.completionTokens += completionTokens;
    const key = todayKey();
    const day = usage.byDay[key] ?? { pt: 0, ct: 0 };
    day.pt += promptTokens;
    day.ct += completionTokens;
    usage.byDay[key] = day;
    this.queueSave();
  }

  todayTokens(): number {
    const day = this.data.usage.byDay[todayKey()];
    return (day?.pt ?? 0) + (day?.ct ?? 0);
  }
}
