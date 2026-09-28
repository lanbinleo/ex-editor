import { CATEGORY_LABELS, SEVERITY_LABELS } from '../types';
import type { BuddyActions, Suggestion } from '../types';
import { charDiff } from '../core/diff';
import type { Seg } from '../core/diff';

export interface CardOptions {
  /** 卡片底部是否带「定位」按钮（侧边栏用） */
  showLocate?: boolean;
  /** 动作完成后回调（悬浮卡片用来关闭自身） */
  afterAction?: () => void;
}

function appendSegs(parent: HTMLElement, segs: Seg[]): void {
  for (const seg of segs) {
    if (seg.type === 'equal') {
      parent.appendChild(document.createTextNode(seg.text));
    } else {
      parent.createSpan({ cls: seg.type === 'del' ? 'es-diff-del' : 'es-diff-ins', text: seg.text });
    }
  }
}

/**
 * 渲染一张建议卡片（悬浮卡片与侧边栏共用），Writing Buddy 风格：
 * 正文优先——不加盒子感，修改本身用字符级红删绿增标记，元信息退为注释。
 * hasMark=false 表示无法在正文中定位（stale），接受按钮禁用。
 */
export function renderSuggestionCard(
  root: HTMLElement,
  plugin: BuddyActions,
  suggestion: Suggestion,
  hasMark: boolean,
  options: CardOptions = {},
): void {
  root.empty();
  const stale = !hasMark || suggestion.status === 'stale';
  root.addClass('es-card', `es-cat-${suggestion.category}`);
  if (stale) root.addClass('es-card-stale');

  const meta = root.createDiv({ cls: 'es-card-meta' });
  meta.createSpan({ cls: 'es-cat-dot' });
  meta.createSpan({ cls: 'es-card-cat', text: CATEGORY_LABELS[suggestion.category] });
  meta.createSpan({ cls: 'es-card-sep', text: '·' });
  meta.createSpan({ cls: 'es-card-sev', text: SEVERITY_LABELS[suggestion.severity] });
  if (suggestion.source === 'instruction') {
    meta.createSpan({ cls: 'es-card-sep', text: '·' });
    meta.createSpan({ cls: 'es-card-sev', text: '自定义指令' });
  }

  // 字符级内嵌 diff：只标记改动本身，未变文字不加样式
  const body = root.createDiv({ cls: 'es-card-body' });
  appendSegs(body, charDiff(suggestion.original, suggestion.replacement));

  if (suggestion.explanation) {
    root.createDiv({ cls: 'es-card-expl', text: suggestion.explanation });
  }
  if (stale) {
    root.createDiv({ cls: 'es-card-note', text: '原文已变化，无法定位；可重新检查后再处理' });
  }

  const actions = root.createDiv({ cls: 'es-card-actions' });
  const accept = actions.createEl('button', { text: '接受', cls: 'es-btn es-btn-accept' });
  accept.disabled = stale;
  accept.addEventListener('click', (e) => {
    e.stopPropagation();
    plugin.acceptSuggestion(suggestion.id);
    options.afterAction?.();
  });
  const ignore = actions.createEl('button', { text: '忽略', cls: 'es-btn' });
  ignore.addEventListener('click', (e) => {
    e.stopPropagation();
    plugin.ignoreSuggestion(suggestion.id);
    options.afterAction?.();
  });
  if (options.showLocate) {
    const locate = actions.createEl('button', { text: '定位', cls: 'es-btn' });
    locate.disabled = stale;
    locate.addEventListener('click', (e) => {
      e.stopPropagation();
      plugin.revealSuggestion(suggestion.id);
    });
  }
}
