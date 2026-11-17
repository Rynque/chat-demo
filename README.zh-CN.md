# chat-demo

[English](README.md) | 简体中文

基于 DeepSeek API 的静态聊天示例修改的 Agent，完全在浏览器中运行。

本项目提供一个轻量 Agent，用于提升 [Chat Demo](https://github.com/deepseek-ai/chat-demo) 的使用体验，并非 [Deepseek Harness](https://github.com/deepseek-ai/deepseek-harness) 的替代品。

建议你自行部署，或点击 [在线体验](https://seek.notfound.click) 在线使用。请在设置中填写 API Key。

## 运行

准备 Node.js 22.12+ 和 pnpm：

```sh
git clone https://github.com/deepseek-ai/chat-demo.git
cd chat-demo
pnpm install
pnpm dev
```

打开 http://localhost:8090 。

生成静态产物：

```sh
pnpm build
```

产物位于 `dist/`，可部署到静态服务器，也可直接打开 `dist/index.html`。直接打开时，浏览器和 API 服务需允许 `file://` 页面的存储与跨域请求。

## 功能

- 多会话、自动标题、重命名与删除；编辑提问、重新生成和切换消息分支。
- 流式回答、深度思考，支持停止和符合条件的继续生成。
- 附件上传、粘贴与拖拽，语音输入和回复朗读；移动端录音时输入框首行显示实时频谱。
- Markdown、代码高亮、KaTeX 公式和 Mermaid 图表。
- 简体中文与英文、浅色与深色主题、移动端布局、位置设置、历史导入导出。
- 内置轻量 Agent 循环，模型可多轮调用工具。
- 内置工具包括原先的联网搜索、网页抓取；新增的会话级虚拟文件系统和 Javascript 沙箱。

## 数据

API Key 和设置保存在浏览器 localStorage，会话及附件原件保存在 IndexedDB，本地数据按浏览器用户配置和站点源（origin）隔离。发送对话、上传附件和使用语音功能时，相应内容会提交给配置的 API 服务。

设置中的历史导入导出使用 ZIP 格式。导入会在确认并校验成功后替换全部本地会话和附件；导出包含会话与本地可用的图片原件，不包含 API Key、设置或非图片附件原件。格式与保留范围见[历史导入导出](src/services/chat/history/README.md)。

设置 → 数据管理 → 删除所有对话，会在确认后清空全部本地会话、附件原件和未发送的草稿，停止正在生成的回复并回到新对话。API Key 和其他设置保留，已上传到 API 服务的文件不受影响。

## 开发

| 命令          | 用途                |
| ------------- | ------------------- |
| `pnpm dev`    | 启动开发服务器      |
| `pnpm build`  | 构建到 `dist/`      |
| `pnpm type`   | TypeScript 类型检查 |
| `pnpm lint`   | oxlint 检查         |
| `pnpm format` | oxfmt 格式化        |

[rspack.config.ts](rspack.config.ts) 默认连接 `https://api.deepseek.com`。`createConfig({ apiOrigin, devServer })` 支持自定义 API 地址和开发服务器代理。

聊天默认使用 `deepseek-flash`，消息通过 Chat Completions（`/chat/completions`）发送，附件通过 Anthropic 兼容的 Files API（`/anthropic/v1/files`）上传；语音使用 ASR / TTS 接口。联网搜索与网页抓取声明为客户端工具（`web_search` / `fetch_url`），由浏览器调用 `/v1/tools/search` 与 `/v1/tools/fetch` 执行，模型返回 `tool_use` 后本地执行、回传 `tool_result` 再继续生成。请求还使用标题、`latest_reminder` 等扩展，接入服务需支持相应能力。附件实际支持的格式以服务端校验为准。

实现要点：

- 工具在浏览器执行：`src/services/tools.ts` 注册 `web_search`、`fetch_url`、`vfs_list`、`vfs_read`、`vfs_write`、`vfs_delete`、`js_run`、`js_run_file`。模型返回 `tool_use` 后本地执行，结果作为 `tool_result` 回传；单条回复最多 4 轮工具往返，同名同参的重复调用只执行一次。
- 虚拟文件系统：`src/services/vfs.ts` 使用 IndexedDB 的 `vfs` 存储，按会话隔离；单文件大小、总量与文件数配额可在设置中调整，超出时工具返回错误。
- JavaScript 沙箱：`src/services/tools/jsWorker.ts` 在 Worker 中执行，默认 5 秒超时后终止；环境不提供 `require`、`fetch` 与 DOM，只注入 `console`、`print` 和 `fs`。执行前将会话文件快照进内存，结束后只回写改动过的文件。
- 沙箱用于限制执行时间与误用，不是安全边界：同一 realm 内 `eval`、函数构造器与动态 `import()` 可以绕过全局名遮蔽，不要用它执行不可信代码。

```text
src/
  app/                 应用布局、主题与全局样式
  components/          聊天、设置、Markdown 等界面组件
  i18n/                中英文文案
  services/
    api/               API 请求、SSE、Chat Completions 转换与协议类型
    chat/              会话、消息分支、本地存储与历史导入导出
    markdown/          Markdown 解析、代码高亮与图表
    speech/            录音与朗读
    tools.ts           客户端工具
    tools/             JavaScript 沙箱执行器
    vfs.ts             会话级虚拟文件系统
  utils/               通用工具
```

## 许可证

[MIT](LICENSE)。构建会将许可证复制到 `dist/LICENSE`，分发时请一并保留；第三方依赖遵循各自的许可证。
