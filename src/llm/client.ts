import { requestUrl } from 'obsidian';
import type { ExSettings } from '../types';
import { createSseParser } from './sse';

/** M2 起生成参数仍保持固定收敛：校对要稳定输出，不追求发散 */
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
	/** 思维链 token 数（仅部分服务商返回，如 DeepSeek；GLM 不返回则省略） */
	reasoningTokens?: number;
	finishReason: string;
	durationMs: number;
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
	stream_options?: { include_usage: boolean };
	response_format?: { type: string };
	thinking?: { type: string };
	reasoning_effort?: string;
	[key: string]: unknown;
}

function buildBody(
	settings: ExSettings,
	messages: ChatMessage[],
	jsonMode: boolean,
	stream: boolean,
): ChatBody {
	const body: ChatBody = {
		model: settings.model,
		messages,
		temperature: TEMPERATURE,
		max_tokens: MAX_TOKENS,
		stream,
	};
	if (stream) body.stream_options = { include_usage: true };
	if (jsonMode) body.response_format = { type: 'json_object' };
	switch (settings.thinkingLevel) {
		case 'off':
			body.thinking = { type: 'disabled' };
			break;
		case 'low':
		case 'medium':
		case 'high':
		case 'max':
			body.reasoning_effort = settings.thinkingLevel;
			break;
		default:
			break; // auto：不发送，跟随服务商默认
	}
	return body;
}

interface HttpResult {
	status: number;
	text: string;
}

/** 非流式 fetch（可取消、可超时）。网络层失败（CORS/断网）返回 null，交给 requestUrl 兜底。 */
async function postViaFetch(
	settings: ExSettings,
	body: ChatBody,
	signal?: AbortSignal,
): Promise<HttpResult | null> {
	const url = settings.baseURL.replace(/\/+$/, '') + '/chat/completions';
	const controller = new AbortController();
	const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_SEC * 1000);
	const onOuterAbort = (): void => controller.abort();
	signal?.addEventListener('abort', onOuterAbort);
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
		if (signal?.aborted) throw new LlmError('已取消');
		if (e instanceof Error && e.name === 'AbortError') {
			throw new LlmError(`请求超时（${REQUEST_TIMEOUT_SEC}s）`);
		}
		return null; // 网络层失败：可能被 CORS 拦截，尝试 requestUrl
	} finally {
		signal?.removeEventListener('abort', onOuterAbort);
		window.clearTimeout(timer);
	}
}

/** requestUrl 绕过 CORS（不支持中断与流式，超时后放弃等待，后台请求完成即被忽略） */
async function postViaRequestUrl(settings: ExSettings, body: ChatBody): Promise<HttpResult> {
	const url = settings.baseURL.replace(/\/+$/, '') + '/chat/completions';
	const timeout = new Promise<never>((_, reject) => {
		window.setTimeout(
			() => reject(new LlmError(`请求超时（${REQUEST_TIMEOUT_SEC}s）`)),
			REQUEST_TIMEOUT_SEC * 1000,
		);
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

async function postJson(
	settings: ExSettings,
	body: ChatBody,
	signal?: AbortSignal,
): Promise<HttpResult> {
	const fetched = await postViaFetch(settings, body, signal);
	if (fetched) return fetched;
	return postViaRequestUrl(settings, body);
}

export interface ChatOptions {
	/** 默认 true；重写模式输出纯文本时传 false */
	jsonMode?: boolean;
	/** 外部取消信号（用户取消检查） */
	signal?: AbortSignal;
}

export interface StreamCallbacks {
	/** 正文增量（流式时逐段触发；非流式兜底时一次性触发） */
	onContentDelta?: (delta: string, fullSoFar: string) => void;
	/** 思维链增量；charsSoFar 为已累计思考字数 */
	onReasoningDelta?: (delta: string, charsSoFar: number) => void;
}

interface StreamUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	completion_tokens_details?: { reasoning_tokens?: number };
}

function parseUsage(u: StreamUsage | undefined | null): {
	promptTokens: number;
	completionTokens: number;
	reasoningTokens?: number;
} {
	const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
	return {
		promptTokens: num(u?.prompt_tokens),
		completionTokens: num(u?.completion_tokens),
		reasoningTokens:
			typeof u?.completion_tokens_details?.reasoning_tokens === 'number'
				? u.completion_tokens_details.reasoning_tokens
				: undefined,
	};
}

function checkChoice(result: { content: string; finishReason: string }): void {
	if (result.content.trim() === '') {
		throw new LlmError('模型返回了空内容');
	}
	if (result.finishReason === 'length') {
		throw new LlmError('输出达到 max_tokens 上限被截断，请缩短检查范围后重试');
	}
}

/**
 * OpenAI 兼容 chat/completions 流式调用（fetch + ReadableStream）。
 * fetch 网络层失败时自动回落 requestUrl 非流式（requestUrl 不支持流式）。
 */
export async function chatCompletionStream(
	settings: ExSettings,
	messages: ChatMessage[],
	options: ChatOptions & StreamCallbacks = {},
): Promise<ChatResult> {
	if (!settings.baseURL || !settings.apiKey || !settings.model) {
		throw new LlmError('请先在 ExEditor 设置中配置 API 地址、密钥与模型');
	}
	const started = Date.now();
	const jsonMode = options.jsonMode !== false;
	let body = buildBody(settings, messages, jsonMode, true);
	try {
		return await streamOnce(settings, body, options, started);
	} catch (e) {
		if (e instanceof LlmError && e.retryWithoutJsonMode && body.response_format) {
			delete body.response_format;
			return streamOnce(settings, body, options, started);
		}
		// 网络层失败（postStream 内部已识别）：去掉流式参数走非流式兜底
		if (e instanceof LlmError && e.message === '__network__') {
			body = buildBody(settings, messages, jsonMode, false);
			return nonStreamOnce(settings, body, options, started);
		}
		throw e;
	}
}

async function streamOnce(
	settings: ExSettings,
	body: ChatBody,
	options: ChatOptions & StreamCallbacks,
	started: number,
): Promise<ChatResult> {
	const url = settings.baseURL.replace(/\/+$/, '') + '/chat/completions';
	const controller = new AbortController();
	const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_SEC * 1000);
	const onOuterAbort = (): void => controller.abort();
	options.signal?.addEventListener('abort', onOuterAbort);
	const finish = (): void => {
		options.signal?.removeEventListener('abort', onOuterAbort);
		window.clearTimeout(timer);
	};

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
		if (!res.ok || !res.body) {
			const text = await res.text();
			throw extractApiError(res.status, text);
		}
		const result = await readStream(res.body, options);
		checkChoice(result);
		return { ...result, durationMs: Date.now() - started };
	} catch (e) {
		if (e instanceof LlmError) throw e;
		if (options.signal?.aborted) throw new LlmError('已取消');
		if (e instanceof Error && e.name === 'AbortError') {
			throw new LlmError(`请求超时（${REQUEST_TIMEOUT_SEC}s）`);
		}
		throw new LlmError('__network__');
	} finally {
		finish();
	}
}

/** 逐 chunk 读 SSE 流，聚合正文/思维链/usage（兼容 usage-only chunk 与 null usage chunk） */
async function readStream(
	stream: ReadableStream<Uint8Array>,
	callbacks: StreamCallbacks,
): Promise<{
	content: string;
	finishReason: string;
	promptTokens: number;
	completionTokens: number;
	reasoningTokens?: number;
}> {
	const reader = stream.getReader();
	const decoder = new TextDecoder('utf-8');
	let content = '';
	let reasoningChars = 0;
	let finishReason = '';
	let usage: StreamUsage | undefined;
	let sawDone = false;

	const handleData = (data: string): void => {
		if (data === '[DONE]') {
			sawDone = true;
			return;
		}
		let chunk: {
			choices?: { delta?: { content?: unknown; reasoning_content?: unknown }; finish_reason?: unknown }[];
			usage?: StreamUsage | null;
			error?: { message?: string; msg?: string } | string;
		};
		try {
			chunk = JSON.parse(data) as typeof chunk;
		} catch {
			return; // 跳过无法解析的 chunk
		}
		if (chunk.error) {
			const msg =
				typeof chunk.error === 'string' ? chunk.error : (chunk.error.message ?? chunk.error.msg ?? '');
			throw new LlmError(`流式返回出错：${msg}`);
		}
		if (chunk.usage) usage = chunk.usage;
		const choice = chunk.choices?.[0];
		const delta = choice?.delta;
		if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content) {
			reasoningChars += delta.reasoning_content.length;
			callbacks.onReasoningDelta?.(delta.reasoning_content, reasoningChars);
		}
		if (typeof delta?.content === 'string' && delta.content) {
			content += delta.content;
			callbacks.onContentDelta?.(delta.content, content);
		}
		if (typeof choice?.finish_reason === 'string' && choice.finish_reason) {
			finishReason = choice.finish_reason;
		}
	};

	const parser = createSseParser(handleData);
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			parser.push(decoder.decode(value, { stream: true }));
		}
		parser.push(decoder.decode());
		parser.end();
	} catch (e) {
		if (e instanceof LlmError) throw e;
		// 流被外力中断（非用户取消、非超时）：已收到部分内容则容错使用，否则报网络错误
		if (!content) throw new LlmError('__network__');
	}
	if (!sawDone && !content && !usage) {
		throw new LlmError('连接提前结束，未收到任何内容');
	}
	const parsed = parseUsage(usage);
	return { content, finishReason, ...parsed };
}

/** 非流式兜底/测试连接路径 */
async function nonStreamOnce(
	settings: ExSettings,
	body: ChatBody,
	callbacks: StreamCallbacks,
	started: number,
): Promise<ChatResult> {
	const res = await postJson(settings, body);
	let data: { choices?: unknown[]; usage?: StreamUsage };
	try {
		data = JSON.parse(res.text || '{}') as typeof data;
	} catch {
		throw new LlmError('模型返回的内容无法解析');
	}
	const choice = (data.choices ?? [])[0] as
		| { message?: { content?: unknown; reasoning_content?: unknown }; finish_reason?: unknown }
		| undefined;
	const content = choice?.message?.content;
	const result = {
		content: typeof content === 'string' ? content : '',
		finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : '',
		...parseUsage(data.usage),
	};
	checkChoice(result);
	if (result.content) callbacks.onContentDelta?.(result.content, result.content);
	if (typeof choice?.message?.reasoning_content === 'string' && choice.message.reasoning_content) {
		callbacks.onReasoningDelta?.(
			choice.message.reasoning_content,
			choice.message.reasoning_content.length,
		);
	}
	return { ...result, durationMs: Date.now() - started };
}

/** 兼容入口：内部走流式（带回调），行为与 chatCompletionStream 相同 */
export async function chatCompletion(
	settings: ExSettings,
	messages: ChatMessage[],
	options: ChatOptions = {},
): Promise<ChatResult> {
	return chatCompletionStream(settings, messages, options);
}

/** 设置页「测试连接」（短回复即可） */
export async function testConnection(settings: ExSettings): Promise<string> {
	const result = await chatCompletionStream(
		settings,
		[{ role: 'user', content: '请只回复两个字：正常' }],
		{ jsonMode: false },
	);
	return result.content.trim().slice(0, 50);
}
