/** 建议类别 */
export type Category = 'typo' | 'punctuation' | 'grammar' | 'wording';
/** 严重程度 */
export type Severity = 'certain' | 'probable' | 'contextual';
/** 建议状态：pending 待处理 / accepted 已接受 / ignored 已忽略 / stale 原文已变化无法定位 */
export type SuggestionStatus = 'pending' | 'accepted' | 'ignored' | 'stale';
/** 建议来源：full 全文 / selection 选区 / paragraph 段落 / instruction 自定义指令 */
export type SuggestionSource = 'full' | 'selection' | 'paragraph' | 'instruction';

export const CATEGORIES: Category[] = ['typo', 'punctuation', 'grammar', 'wording'];
export const SEVERITIES: Severity[] = ['certain', 'probable', 'contextual'];

export const CATEGORY_LABELS: Record<Category, string> = {
  typo: '错别字',
  punctuation: '标点',
  grammar: '语法',
  wording: '措辞',
};

export const SEVERITY_LABELS: Record<Severity, string> = {
  certain: '确定',
  probable: '可能',
  contextual: '视语境',
};

/** 一条校对建议。original 必须与文档中的文字逐字一致（用于定位与安全替换）。 */
export interface Suggestion {
  id: string;
  original: string;
  replacement: string;
  category: Category;
  severity: Severity;
  explanation: string;
  status: SuggestionStatus;
  source: SuggestionSource;
  createdAt: number;
}

/** 模型返回的原始 issue（字段未校验） */
export interface RawIssue {
  original?: unknown;
  replacement?: unknown;
  category?: unknown;
  severity?: unknown;
  explanation?: unknown;
}

export type InstructionMode = 'suggest' | 'rewrite';

/** 重写模式的待应用预览 */
export interface RewritePreview {
  path: string;
  from: number;
  to: number;
  original: string;
  rewritten: string;
  instruction: string;
}

export interface WBSettings {
  /** 预设名：deepseek / glm / kimi / openai / ollama / custom */
  preset: string;
  baseURL: string;
  apiKey: string;
  model: string;
  /** 思维链参数形态：none 不发送 / thinking {thinking:{type:'enabled'}} / effort reasoning_effort */
  reasoningMode: 'none' | 'thinking' | 'effort';
  reasoningEffort: 'low' | 'medium' | 'high';
  maxTokens: number;
  temperature: number;
  requestTimeoutSec: number;
  useJsonMode: boolean;
  /** 优先使用 obsidian requestUrl（绕过 CORS），失败可关闭改用 fetch */
  useRequestUrl: boolean;
  /** 附加请求体 JSON，浅合并进请求（高级用法） */
  extraBody: string;
  backupDir: string;
  backupKeep: number;
  backupOnCheck: boolean;
  /** 超过该字数仍单请求发送，但给出提示 */
  longDocThreshold: number;
}

export interface UsageTotals {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  byDay: Record<string, { pt: number; ct: number }>;
}

export interface FileCheckState {
  suggestions: Suggestion[];
  contentHash: string;
  checkedAt: number;
}

export interface StoreData {
  settings: WBSettings;
  usage: UsageTotals;
  files: Record<string, FileCheckState>;
}

/**
 * UI 层（悬浮卡片 / 侧边栏）依赖的插件动作集合。
 * 插件实现该接口；卡片渲染只依赖它，避免循环依赖。
 */
export interface BuddyActions {
  getSuggestion(id: string): Suggestion | undefined;
  acceptSuggestion(id: string): void;
  ignoreSuggestion(id: string): void;
  revealSuggestion(id: string): void;
  focusSidebarCard(id: string): void;
}
