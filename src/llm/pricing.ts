import type { ExSettings, ModelPricing } from '../types';

/**
 * 内置模型价格（人民币元 / 百万 tokens，2026-09 官方定价页核对）。
 * 估算口径（偏保守）：
 * - DeepSeek 分高峰/空闲时段，取高峰价；缓存命中折扣不计（实际只会更便宜）
 * - 智谱按输入/输出长度分档，取校对场景典型档（输入 <32K、输出 ≥0.2K）
 * - 思维链 token 计入 completion_tokens，按输出价计费
 * - glm-4.6 / glm-4.5 官方已下架定价（未确认），不写入来路不明的数字；用户可在设置中自填
 */
export const DEFAULT_PRICING: Record<string, ModelPricing> = {
	'deepseek-flash': { input: 2, output: 8 },
	'deepseek-v4-pro': { input: 9, output: 27 },
	'glm-4.5-air': { input: 0.8, output: 6 },
	'glm-4.7': { input: 3, output: 14 },
	'glm-5.3': { input: 8, output: 28 },
	'glm-5.2': { input: 8, output: 28 },
};

/** 生效价格：用户自定义优先，其次内置官方价，都没有返回 null（不计费） */
export function getPricing(settings: ExSettings, model: string): ModelPricing | null {
	return settings.pricing?.[model] ?? DEFAULT_PRICING[model] ?? null;
}

/** 估算一次运行的费用（元） */
export function estimateCostYuan(
	pricing: ModelPricing,
	promptTokens: number,
	completionTokens: number,
): number {
	return (promptTokens / 1e6) * pricing.input + (completionTokens / 1e6) * pricing.output;
}

/** 费用显示：小额多留小数位，避免全是 ¥0.00 */
export function formatYuan(yuan: number): string {
	if (yuan <= 0) return '¥0';
	if (yuan < 0.01) return `¥${yuan.toFixed(4)}`;
	if (yuan < 1) return `¥${yuan.toFixed(3)}`;
	return `¥${yuan.toFixed(2)}`;
}
