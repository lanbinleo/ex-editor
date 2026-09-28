import type { RawIssue } from '../types';

/**
 * 解析模型返回的 JSON（issues 列表）。
 * 防御性处理：剥离 ```json 围栏、截取首尾大括号之间的内容、容忍顶层是数组。
 * 解析失败抛出带中文说明的 Error。
 */
export function parseIssues(content: string): RawIssue[] {
  let text = content.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
  if (fence) text = fence[1].trim();
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    // 容忍模型在 JSON 前后输出多余文字：截取首尾大括号之间的部分再试
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('模型输出中未找到 JSON 内容');
    }
    try {
      obj = JSON.parse(text.slice(start, end + 1));
    } catch (e) {
      throw new Error(`模型输出的 JSON 无法解析：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  let arr: unknown;
  if (Array.isArray(obj)) arr = obj;
  else if (obj && typeof obj === 'object' && Array.isArray((obj as { issues?: unknown }).issues)) {
    arr = (obj as { issues: unknown[] }).issues;
  } else {
    arr = [];
  }
  return (arr as unknown[]).filter(
    (o): o is RawIssue => !!o && typeof o === 'object' && !Array.isArray(o),
  );
}
