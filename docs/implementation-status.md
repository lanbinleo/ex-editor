# 实现状态 — ExEditor

> 每个里程碑完成时更新本文件：已完成能力、验证记录、当前限制、下一步入口。

## 当前：M1 最小安全闭环（0.2.0，2026-09-28，真机验收通过）

### 已完成

- [x] M0 骨架（0.1.0）：已提交 `1754379` 并打标签 `v0.1.0`；真机验证通过（加载无报错、冒烟命令可执行）
- [x] 安全核心五模块从 legacy 移植 + 单测：`parse` / `protected` / `validate` / `diff` / `apply`
  - `apply` 与 M2 的编辑器标记解耦：`planBatchEdit` 返回纯数据（changes + remaining），不依赖 StateField
  - 修复 legacy 潜伏 bug：`paragraphRange` 前向循环因 CM6 边界语义死循环（`lineAt(换行位置)` 返回前一行，`to` 不前进）；新增 `tests/paragraph.spec.ts` 回归覆盖
- [x] LLM 客户端：OpenAI 兼容 chat/completions；fetch + AbortController 优先，网络层失败自动回落 obsidian requestUrl；400 且带 response_format 时自动去掉重试；全中文错误提示
- [x] 设置页：预设（DeepSeek / GLM / 自定义）+ API 地址 + API 密钥 + 模型名 + 测试连接；密钥只存本机 data.json
- [x] 「检查本段落」命令：空行分段 → 校对提示词 → 解析 → 唯一定位 → 建议入库；同范围重复检查时旧建议被替换；有建议时自动打开侧边栏
- [x] 侧边栏 v1：卡片按 id 精确增删改（无整体重渲染，保留 DOM/焦点/滚动）；字符级 diff、分类与级别、解释；逐条接受（单事务、Ctrl+Z 可撤销）/ 忽略 / 定位
- [x] 安全协议落地：接受/定位前重新验证原文（检查时位置精确匹配 → 全文唯一出现 → 两者失败标 stale 丢弃，绝不猜位置）

### 验证记录（2026-09-28）

| 验证项 | 结果 |
|---|---|
| `npm run build`（tsc + esbuild production） | ✅ 通过 |
| `npm test`（vitest） | ✅ 7 个文件 41 个测试全过 |
| `npm run lint` | ✅ 0 error（1 个信息性 warning：声明式设置 API，当前 obsidian 类型包尚无该类型，M5 评估） |
| Obsidian 真机 | ✅ 2026-09-28 用户确认：检查、建议展示、接受替换、Ctrl+Z 撤销全链路正常 |

### 真机验收清单（用户操作）

1. 设置 → ExEditor：选预设（DeepSeek/GLM）、填 API 密钥，点「测试连接」应返回「连接成功」
2. 打开一篇笔记，光标放进一段含错别字/语病的文字，命令面板执行「ExEditor: 检查本段落」
3. 侧边栏自动打开并出现建议卡片（红删绿增 diff + 理由）
4. 点「接受」：文字正确替换；**Ctrl+Z 一次完整撤销**
5. 先手动改动段落再点「接受」：应提示原文已变化，绝不错替换
6. 点「忽略」：卡片消失；点卡片或「定位」：编辑器选中原文并滚动到位

### 当前限制（已知，按 roadmap 后续里程碑解决）

- 建议为内存态：重启 Obsidian 后清空（重新检查即可恢复）；持久化待后续里程碑
- 无编辑器内波浪线标记（M2）；无全文/批量/取消（M3）；无指令重写与快照（M4）
- 用户编辑后其余建议位置不实时重排（接受时的安全重定位兜底，M2 编辑器标记解决）
- LLM 生成参数固定（temperature 0 / max_tokens 16384 / 超时 300s），开放为设置项待 M3 客户端重写
- minAppVersion 提升至 1.7.2（revealLeaf 异步形式所需）

### 下一步（M2 入口）

1. CM6 StateField + 波浪线 decoration（按类别分色），标记随编辑自动映射、失效标 stale
2. M2 起 `planBatchEdit` 的 `remaining` 接入 StateField，接受后同步清理标记
3. 悬浮卡片（复用 `src/view/card.ts`）+ 右键菜单（标记上接受/忽略；选中文字检查）
