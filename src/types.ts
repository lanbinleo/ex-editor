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

/** 一条已定位到文档的建议。from/to 是定位结果，随编辑可能失效，使用前必须重新验证。 */
export interface SuggestionEntry {
  suggestion: Suggestion;
  from: number;
  to: number;
}

/** 模型返回的原始 issue（字段未校验） */
export interface RawIssue {
  original?: unknown;
  replacement?: unknown;
  category?: unknown;
  severity?: unknown;
  explanation?: unknown;
}

/** 检查强度：light 只查错别字标点（最小修改）/ standard 病句+错别字（默认）/ deep 深度润色 */
export type CheckStrength = 'light' | 'standard' | 'deep';

export const STRENGTH_LABELS: Record<CheckStrength, string> = {
	light: '错别字',
	standard: '病句',
	deep: '润色',
};

/** 思考深度：auto 不发参数（跟随服务商默认）/ off 显式关闭 / low·medium·high·max → reasoning_effort */
export type ThinkingLevel = 'auto' | 'off' | 'low' | 'medium' | 'high' | 'max';

/** 模型价格（人民币元 / 百万 tokens），用于费用估算 */
export interface ModelPricing {
	input: number;
	output: number;
}

/** 重写预览：等待用户确认应用的整段改写 */
export interface RewritePreview {
	path: string;
	from: number;
	to: number;
	original: string;
	rewritten: string;
	instruction: string;
	/** 流式进行中：界面先显示纯文本，完成后切换为 diff */
	streaming: boolean;
	startedAt: number;
}

/** M1 设置：单一 OpenAI 兼容提供商，密钥只存本地 data.json */
export interface ExSettings {
	/** 预设名：deepseek / glm / custom */
	preset: string;
	baseURL: string;
	apiKey: string;
	model: string;
	thinkingLevel: ThinkingLevel;
	/** 检查强度（侧边栏选择器修改，持久化） */
	checkStrength: CheckStrength;
	/** 按模型名自定义价格（覆盖内置官方价）；键为模型名 */
	pricing: Record<string, ModelPricing>;
	/** 快照备份目录（vault 内路径） */
	backupDir: string;
	/** 每篇笔记保留的快照数量上限 */
	backupKeep: number;
}
