import { requestUrl } from 'obsidian';
import type { ExSettings } from '../types';

/** M1 固定生成参数：校对要稳定输出，不追求发散 */
const TEMPERATURE = 0;
const MAX_TOKENS = 16384;
const REQUEST_TIMEOUT_SEC = 300;

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface ChatResult {
	content: string;
	promptTokens: number;
	completionTokens: number;
	finishReason: string;
}

export class LlmError extends Error {
	/** 400 且可能由 response_format 引起时，自动去掉 json mode 重试一次 */
	public retryWithoutJsonMode = false;

	constructor(message: string, public status?: number) {
		super(message);
		this.name = 'LlmError';
	}
}

function extractApiError(status: number, bodyText: string): LlmError {
	let detail = bodyText.slice(0, 300);
	try {
		const parsed = JSON.parse(bodyText) as {
			error?: { message?: string; msg?: string };
			message?: string;
			msg?: string;
		};
		detail = parsed.error?.message ?? parsed.error?.msg ?? parsed.message ?? parsed.msg ?? detail;
	} catch {
		/* 保留原文 */
	}
	const hint =
		status === 401 || status === 403
			? '（检查 API Key 是否正确/有效）'
			: status === 429
				? '（请求过频或额度不足）'
				: status >= 500
					? '（服务端错误，可稍后重试）'
					: '';
	const err = new LlmError(`API ${status}：${detail}${hint}`, status);
	if (status === 400) err.retryWithoutJsonMode = true;
	return err;
}

interface ChatBody {
	model: string;
	messages: ChatMessage[];
	temperature: number;
	max_tokens: number;
	stream: boolean;
	response_format?: { type: string };
	[key: string]: unknown;
}

function buildBody(settings: ExSettings, messages: ChatMessage[], jsonMode: boolean): ChatBody {
	const body: ChatBody = {
		model: settings.model,
		messages,
		temperature: TEMPERATURE,
		max_tokens: MAX_TOKENS,
		stream: false,
	};
	if (jsonMode) body.response_format = { type: 'json_object' };
	return body;
}

interface HttpResult {
	status: number;
	text: string;
}

/** fetch + AbortController（可取消、可超时）。网络层失败（CORS/断网）返回 null，交给 requestUrl 兜底。 */
async function postViaFetch(
	settings: ExSettings,
	body: ChatBody,
): Promise<HttpResult | null> {
	const url = settings.baseURL.replace(/\/+$/, '') + '/chat/completions';
	const controller = new AbortController();
	const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_SEC * 1000);
	try {
		const res = await window.fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${settings.apiKey}`,
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		const text = await res.text();
		if (!res.ok) throw extractApiError(res.status, text);
		return { status: res.status, text };
	} catch (e) {
		if (e instanceof LlmError) throw e;
		if (e instanceof Error && e.name === 'AbortError') {
			throw new LlmError(`请求超时（${REQUEST_TIMEOUT_SEC}s）`);
		}
		return null; // 网络层失败：可能被 CORS 拦截，尝试 requestUrl
	} finally {
		window.clearTimeout(timer);
	}
}

/** requestUrl 绕过 CORS（不支持中断，超时后放弃等待，后台请求完成即被忽略） */
async function postViaRequestUrl(settings: ExSettings, body: ChatBody): Promise<HttpResult> {
	const url = settings.baseURL.replace(/\/+$/, '') + '/chat/completions';
	const timeout = new Promise<never>((_, reject) => {
		window.setTimeout(() => reject(new LlmError(`请求超时（${REQUEST_TIMEOUT_SEC}s）`)), REQUEST_TIMEOUT_SEC * 1000);
	});
	const res = await Promise.race([
		requestUrl({
			url,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${settings.apiKey}`,
			},
			body: JSON.stringify(body),
			throw: false,
		}),
		timeout,
	]);
	const text = typeof res.text === 'string' ? res.text : '';
	if (res.status >= 400) throw extractApiError(res.status, text);
	return { status: res.status, text };
}

async function postJson(settings: ExSettings, body: ChatBody): Promise<HttpResult> {
	const fetched = await postViaFetch(settings, body);
	if (fetched) return fetched;
	return postViaRequestUrl(settings, body);
}

export interface ChatOptions {
	/** 默认 true；重写模式输出纯文本时传 false */
	jsonMode?: boolean;
}

/** OpenAI 兼容 chat/completions 非流式调用 */
export async function chatCompletion(
	settings: ExSettings,
	messages: ChatMessage[],
	options: ChatOptions = {},
): Promise<ChatResult> {
	if (!settings.baseURL || !settings.apiKey || !settings.model) {
		throw new LlmError('请先在 ExEditor 设置中配置 API 地址、密钥与模型');
	}
	const jsonMode = options.jsonMode !== false;
	const body = buildBody(settings, messages, jsonMode);
	let data: { choices?: unknown[]; usage?: Record<string, unknown> };
	try {
		const res = await postJson(settings, body);
		data = JSON.parse(res.text || '{}') as typeof data;
	} catch (e) {
		if (e instanceof LlmError && e.retryWithoutJsonMode && body.response_format) {
			delete body.response_format;
			const res = await postJson(settings, body);
			data = JSON.parse(res.text || '{}') as typeof data;
		} else {
			throw e;
		}
	}

	const choice = (data.choices ?? [])[0] as
		| { message?: { content?: unknown }; finish_reason?: unknown }
		| undefined;
	const content = choice?.message?.content;
	if (typeof content !== 'string' || content.trim() === '') {
		throw new LlmError('模型返回了空内容');
	}
	if (choice?.finish_reason === 'length') {
		throw new LlmError('输出达到 max_tokens 上限被截断，请缩短检查范围后重试');
	}
	const usage = data.usage ?? {};
	const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
	return {
		content,
		promptTokens: num(usage['prompt_tokens']),
		completionTokens: num(usage['completion_tokens']),
		finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : '',
	};
}

/** 设置页「测试连接」 */
export async function testConnection(settings: ExSettings): Promise<string> {
	const result = await chatCompletion(
		settings,
		[{ role: 'user', content: '请只回复两个字：正常' }],
		{ jsonMode: false },
	);
	return result.content.trim().slice(0, 50);
}
