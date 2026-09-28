import { Decoration, EditorView, hoverTooltip } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import type { EditorState } from '@codemirror/state';
import {
  activeFindingField,
  collectFindings,
  findMarkAt,
  findingsField,
  setActiveFinding,
} from './findingsField';
import { renderSuggestionCard } from '../view/card';
import type { BuddyActions } from '../types';

/**
 * CM6 的 mark 装饰不允许跨行：跨行会产生坏 DOM 并破坏选区。
 * 把一条建议按行拆成多段装饰（同一条建议的多行各画一段波浪线）。
 */
function pushMarkRanges(
  decos: { from: number; to: number; deco: Decoration }[],
  state: EditorState,
  from: number,
  to: number,
  deco: Decoration,
): void {
  let pos = from;
  while (pos < to) {
    const line = state.doc.lineAt(pos);
    const end = Math.min(to, line.to);
    if (end > pos) decos.push({ from: pos, to: end, deco });
    pos = end === line.to ? line.to + 1 : end;
  }
}

/**
 * 注册给 Obsidian 的编辑器扩展集合：
 * - findingsField / activeFindingField：状态
 * - 装饰：按类别着色的波浪下划线（跨行自动拆段），激活态加底色
 * - hoverTooltip：悬浮卡片（原文→建议 + 接受/忽略）
 * - mousedown：点击标记 → 激活并联动侧边栏卡片（不拦截，保证框选/光标正常）
 */
export function buildEditorExtensions(plugin: BuddyActions): Extension[] {
  return [
    findingsField,
    activeFindingField,
    EditorView.decorations.compute([findingsField, activeFindingField], (state) => {
      const active = state.field(activeFindingField);
      const ranges: { from: number; to: number; deco: Decoration }[] = [];
      for (const m of collectFindings(state)) {
        const deco = Decoration.mark({
          class: `es-mark es-cat-${m.category}${m.id === active ? ' es-active' : ''}`,
          attributes: { 'data-es-id': m.id },
        });
        pushMarkRanges(ranges, state, m.from, m.to, deco);
      }
      return Decoration.set(ranges.map((r) => r.deco.range(r.from, r.to)), true);
    }),
    hoverTooltip(
      (view, pos) => {
        const mark = findMarkAt(view.state, pos);
        if (!mark) return null;
        const suggestion = plugin.getSuggestion(mark.id);
        if (!suggestion) return null;
        return {
          pos: mark.from,
          end: mark.to,
          above: true,
          class: 'es-tooltip-host',
          create: () => {
            const dom = document.createElement('div');
            dom.className = 'es-tooltip';
            renderSuggestionCard(dom, plugin, suggestion, suggestion.status !== 'stale', {
              afterAction: () => {
                dom.closest('.cm-tooltip')?.remove();
              },
            });
            return { dom };
          },
        };
      },
      { hoverTime: 200 },
    ),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        const target = event.target as HTMLElement | null;
        const el = target?.closest?.('[data-es-id]') as HTMLElement | null;
        if (!el) return false;
        const id = el.getAttribute('data-es-id');
        if (!id) return false;
        // 只联动高亮，不消费事件——框选、双击选词、光标移动保持原生行为
        view.dispatch({ effects: setActiveFinding.of(id) });
        plugin.focusSidebarCard(id);
        return false;
      },
    }),
  ];
}
