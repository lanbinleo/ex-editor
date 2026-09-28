# 编辑建议 (Editing Suggestions)

中文写作者的 AI 校对 Obsidian 插件：一次 LLM 请求全文逐句分析，正文波浪线标记与悬浮卡片，配合侧边栏审阅、自定义指令和快照备份。

## 功能

- **全文单请求校对**：不分段，一次请求全文，模型在思维链中逐句深度分析（支持 reasoning 参数），输出可核验的修改对照表。
- **正文波浪线标记**：错别字（珊瑚红）、标点（琥珀）、语法（靛蓝）、措辞（紫罗兰），浅色/深色主题自适应；打字时位置自动映射，不错位；跨行建议按行分段标注，不影响框选与光标。
- **悬浮卡片**：悬停标记显示字符级红删绿增对照 + 理由，可直接接受/忽略；接受即编辑器事务，可 Ctrl+Z 撤销。
- **侧边栏审阅**：建议列表、分段式类别筛选、级别过滤、点击定位到正文、批量接受/忽略；卡片与正文标记双向联动高亮。
- **右键快查**：选中一段文字右键「检查选中文字」，或对光标所在段落快速检查。
- **自定义指令**：建议模式（结果进入同一套逐条确认闭环）与重写模式（字符级前后对照，确认后应用）。
- **持久化与备份**：建议按文件持久化，重启后恢复标记；批量接受/重写/恢复前自动创建纯文本快照，侧边栏可一键恢复。
- **安全协议**：模型只报「原文/替换」对，插件端校验原文唯一出现后才定位；原文变化无法安全应用时宁可标记失效，绝不猜位置。

## 使用

1. 启用插件后，在设置中选择服务商预设（DeepSeek / 智谱 GLM / Kimi / OpenAI / Ollama），填入 API Key，可点「测试连接」验证。
2. 打开一篇文档，点侧栏图标或运行命令「编辑建议：检查全文语法」。
3. 在正文标记上悬停查看悬浮卡片；或打开侧边栏逐条审阅。

## 开发

```bash
npm install        # 安装依赖（.npmrc 已启用 legacy-peer-deps）
npm run check      # 类型检查
npm test           # vitest 单元测试
npm run dev        # esbuild watch 模式
npm run build      # 生产构建
npm run deploy     # 构建并复制到测试 vault（默认 D:\Desktop\写作人生，可用环境变量 WB_VAULT 覆盖）
```

建议搭配 [Hot-Reload](https://github.com/pjeby/hot-reload) 插件在 Obsidian 内热重载。

## 结构

```
main.ts                     # 插件入口：命令/ribbon/右键菜单/状态栏/建议恢复
src/types.ts                # 数据模型（Suggestion / Settings / BuddyActions）
src/llm/                    # OpenAI 兼容客户端 + 提示词
src/core/                   # 校验定位 / 保护语法 / 替换编排 / 字符级 diff / 检查服务
src/editor/                 # CM6 StateField / 装饰（跨行拆段）/ 悬浮卡片 / 点击联动
src/view/                   # 侧边栏 ItemView / 建议卡片渲染
src/storage/                # data.json 持久化 / vault 内快照备份
tests/                      # vitest 单元测试
```
