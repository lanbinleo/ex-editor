import { describe, expect, it } from 'vitest';
import { parseIssues } from '../src/core/parse';

describe('parseIssues', () => {
  it('解析标准 issues 包装', () => {
    const out = parseIssues('{"issues":[{"original":"错吴","replacement":"错误"}]}');
    expect(out).toHaveLength(1);
    expect(out[0].original).toBe('错吴');
  });

  it('剥离 ```json 围栏', () => {
    const out = parseIssues('```json\n{"issues":[{"original":"a","replacement":"b"}]}\n```');
    expect(out).toHaveLength(1);
  });

  it('容忍顶层是数组', () => {
    const out = parseIssues('[{"original":"a","replacement":"b"}]');
    expect(out).toHaveLength(1);
  });

  it('空 issues 返回空数组', () => {
    expect(parseIssues('{"issues":[]}')).toHaveLength(0);
  });

  it('没有 JSON 时抛出可读错误', () => {
    expect(() => parseIssues('抱歉，我不明白')).toThrow(/JSON/);
  });
});
