# 写作搭子 (Writing Buddy) — Obsidian 插件实施计划

## 背景结论

- **Typonomy 不是 Obsidian 插件**（是 Go + React/TipTap 网页应用），编辑器集成需基于 CodeMirror 6 全新实现——这反而更好：CM6 装饰随打字自动映射、替换走编辑器事务（可 Ctrl+Z）、不丢光标/滚动/撤销历史，正好解决 Typonomy 的已知弱点。
- 移植 Typonomy 的**校对管线**：输出协议（模型只报原文/替换对，不报坐标）、响应校验（原文必须唯一出现、枚举白名单、应用前再验证）、快照备份、悬浮卡片交互。
- 现有 Obsidian 插件（LanguageTool Integration 已停维护、Proofreader、Harper 仅英文）没有「中文 AI 校对 + 自定义指令 + 段落自动检查」组合，自建有价值。
- 已确认的决策：**OpenAI 兼容接口 + 常用预设**；**闲置自动检查默认关闭且放二期**；**自定义指令做「建议模式 + 重写模式（diff 预览）」两种**；**首版先交付核心闭环**。

## 技术栈与骨架

- TypeScript (strict) + Obsidian Plugin API，`minAppVersion: 1.5.8`，manifest id `writing-buddy`，名称「写作搭子 (Writing Buddy)」。
- esbuild 构建；`obsidian`、`@codemirror/state`、`@codemirror/view`、`@codemirror/language`、`@codemirror/commands` 标记为 external（Obsidian 运行时提供）。
- UI 用原生 DOM + obsidian 内置组件（不引 React/Svelte，减少工具链）。
- vitest 只测纯逻辑。当前目录为空仓库：先 `git init`，搭标准插件模板结构。

```
WritingBuddy/
├── manifest.json / versions.json / package.json / tsconfig.json / esbuild.config.mjs / styles.css
├── main.ts                        # 入口：注册命令/ribbon/侧边栏视图/编辑器扩展/右键菜单/设置
├── src/
│   ├── types.ts                   # Suggestion、Settings 等数据模型
│   ├── settings.ts                # 设置页（预设下拉 + baseURL/key/model/reasoning effort/超时/maxTokens/备份目录与份数）
│   ├── llm/client.ts              # OpenAI 兼容 chat/completions（obsidian requestUrl 防 CORS，fallback fetch；temperature 0；json_object；thinking/reasoning_effort 可选参数；usage 统计）
│   ├── llm/prompts.ts             # 校对系统提示词 / 自定义指令提示词（建议模式、重写模式）
│   ├── core/checkService.ts       # 检查编排：全文/选区/段落三种范围，状态机 idle→running→done/error，防并发重入
│   ├── core/validate.ts           # 响应校验：original 非空且≠replacement、≤500字、枚举白名单、全文唯一出现（否则丢弃并计数）
│   ├── core/anchor.ts             # 文本→CM6 位置：JS indexOf 偏移即 CM6 位置（同为 UTF-16）；保护范围过滤
│   ├── core/protected.ts          # 保护语法（移植 Typonomy 9 条正则：frontmatter/代码块/行内代码/数学/wikilink/嵌入/图片/callout），叠加 CM6 syntax tree 识别
│   ├── core/apply.ts              # 应用替换：view.dispatch、接受前 re-verify（sliceString 比对）、批量按 from 降序合并进一个事务、失败项跳过并标记 stale
│   ├── editor/findingsField.ts    # CM6 StateField<RangeSet>：StateEffect 更新，事务间自动映射（打字不错位）
│   ├── editor/decorations.ts      # Decoration.mark，class=wb-mark wb-{category} wb-active，data-finding-id
│   ├── editor/tooltip.ts          # hoverTooltip 悬浮卡片（按你截图的样式）：类别/严重度徽标、del 原文→ins 建议、解释、【接受】【忽略】
│   ├── editor/contextMenu.ts      # editor-menu：有选区→「检查选中文字」；无选区→「检查本段落」
│   ├── view/sidebar.ts            # ItemView 侧边栏（见下）
│   ├── view/rewritePreview.ts     # 重写模式：前后对照 diff 视图 + 应用/放弃
│   └── storage/store.ts / backup.ts  # 持久化与备份（见下）
└── tests/                         # vitest：validate/anchor/apply 排序与回退
```

## 核心设计

### 1. 全文单请求检查（需求 2，主路径）
- 命令/侧边栏按钮 → 取编辑器全文 → **一次 LLM 请求**（不分段），`response_format: json_object`、`temperature: 0`、`max_tokens` 可配（默认 16384）、超时默认 300s。
- 提示词按你给的思路重写：角色=资深中文文章编辑；要求逐句通读、在思维链中详细分析语法/用词/句式/错别字，只报值得处理的问题；引号用中文引号等规范写入；输出 JSON：`{"issues":[{"original":"…","replacement":"…","category":"typo|punctuation|grammar|wording","severity":"certain|probable|contextual","explanation":"…"}]}`。协议要点（抄 Typonomy）：**original 必须是原文中连续且完全一致的子串，replacement 只含替换后文字，不改 Markdown 标记/代码/公式/wikilink**。
- 思维链：设置里配 reasoning（`thinking`/`reasoning_effort` 参数，按预设适配 DeepSeek/GLM 等）；无 reasoning 的模型也能跑，靠提示词要求先分析后输出。
- **校验与定位**：解析后逐条校验（白名单/长度/非空/≠replacement），`original` 在全文唯一出现才定位成功（CM6 位置 = JS 字符串偏移，直接 indexOf）；落在保护范围内的丢弃。位置由插件计算，永不信任模型坐标。
- 超长兜底：字数 > 阈值（默认 30000，可改）时 Notice 提示仍单请求发送；若因上下文超限报错，提示可改用「按选区分段检查」。

### 2. 正文标记 + 悬浮卡片（需求 3、4，按你截图）
- `StateField<RangeSet<{id,from,to}>>` + `Decoration.mark`，建议数据存插件层，以 id 关联；**事务间自动 map**，打字、换行不错位。
- 样式：波浪下划线 + 类别色（错别字=珊瑚红、语病=靛蓝、标点=琥珀、措辞=紫罗兰），CSS 变量双主题适配；active 态加低饱和背景。
- `hoverTooltip` 悬浮卡片：错误类型徽标、`原文(红删) → 建议(绿增)`、解释、【接受】【忽略】按钮。接受 = `view.dispatch` 精确替换（可撤销），其余装饰自动重映射。
- 点击正文标记 ↔ 侧边栏卡片双向高亮联动。

### 3. 侧边栏（需求 1、5）
- ItemView「写作搭子」：顶部操作条（全文检查按钮、运行状态/进度、上次检查时间与用时、token 用量）；类别/严重度过滤 chips；建议卡片列表（原文/建议/解释/接受/忽略/定位）；底部【接受全部（按当前过滤）】【忽略全部】。
- 自定义指令区：输入框 + 模式开关（**建议模式**：指令结果输出为结构化建议，走同一套波浪线+卡片闭环；**重写模式**：对选区或全文输出改写结果，侧边栏前后对照预览，点「应用」才写入并**先做快照**）。
- 卡片点击 → `scrollIntoView` + 选中 + active 高亮；定位失败（原文已变）时卡片灰显并提示。

### 4. 右键菜单（需求 7）
- `editor-menu`：有选区 →「写作搭子：检查选中文字」；无选区 →「检查本段落」；右键点在标记上 →「接受此建议 / 忽略此建议」。范围检查结果只替换该范围内的旧建议。

### 5. 持久化与备份（需求 6）
- 设置 + 累计用量：插件 `data.json`。
- 每文件建议缓存：`data.json` 内按 vault 路径存 `{suggestions, contentHash, checkedAt}`；重新打开文件时若 hash 匹配则恢复标记，不匹配则保留建议并尝试唯一匹配重定位，失败标 stale。
- 备份：写入 `{备份目录,默认 .writing-buddy/backups/}<文件相对路径>/<时间戳>.md` 纯文本快照；触发时机=每次「接受全部」/重写应用/恢复前 + 每次检查完成后（可关）；每篇保留 N 份（默认 20）；侧边栏「备份」区列出当前文件的快照并可一键恢复（恢复前再快照当前内容）。

### 6. 二期（本次不做，设置页留位）：段落闲置自动检查
- 脏段落追踪（updateListener 记录受影响段落+时间戳），定时扫描闲置 ≥N 分钟且上次检查后变动过的段落，轻量 prompt 单段检查，默认关闭。

## 里程碑（首版=核心闭环）

- **M1 最小闭环**：骨架 + 设置页（含预设）+ LLM 客户端 + 全文检查命令 + 响应校验定位 + 波浪线装饰 + 悬浮卡片 + 单条接受/忽略。装进 vault 即可用。
- **M2 侧边栏完整体验**：ItemView 全功能 + 过滤 + 批量接受/忽略 + 双向联动跳转 + 右键菜单 + ribbon + 状态栏待处理计数。
- **M3 指令与数据**：自定义指令（建议+重写 diff 预览）+ 每文件建议持久化恢复 + 备份快照与恢复 UI + stale 建议处理。
- **M4 打磨**：双主题颜色调优、长文提示、错误信息完善、README、（若顺手）自动检查的设置占位。

## 验证方式

- vitest：响应校验、唯一出现定位与消歧、批量替换降序与 verify-fallback、保护范围过滤。
- 手动冒烟（真实 vault）：中英混排长文、含代码块/wikilink/公式的文档、边打字边接受、Ctrl+Z 撤销、重启后恢复标记、备份恢复、选区右键检查。
- 构建产物 `main.js + manifest.json + styles.css` 复制到测试 vault `.obsidian/plugins/writing-buddy/` 验证。

## 实施期需要的操作权限

- `git init` 初始化仓库；`npm install` 装依赖；运行 esbuild 构建与 vitest 测试。