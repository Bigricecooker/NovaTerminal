# 开发指南

## 环境与依赖

使用 Node.js `>=24.19.0 <25` 和 npm `>=11.19.1 <12`，在仓库根目录执行 `npm ci`。版本以 `package-lock.json` 为准；依赖变更需同步锁文件。

`node-pty` 是原生模块。若目标平台没有匹配的预构建文件，需要按安装错误和上游构建要求准备工具链。项目 `allowScripts` 仅允许当前 `node-pty` 版本运行安装脚本；`ssh2` 的可选原生加速脚本保持禁用。调整版本时一并检查脚本许可，不修改全局 npm 配置。

主要技术栈为 Vite、React、TypeScript、Tailwind CSS、shadcn/ui、xterm.js、node-pty 和 ssh2。Electron 尚未接入。

## 代码组织

| 位置 | 职责 |
| --- | --- |
| `src/App.tsx` | 页面布局、主题和工作区加载 |
| `src/components/terminal-workspace.tsx` | 标签状态、终端入口和临时凭据交接 |
| `src/components/terminal-session.tsx` | xterm、WebSocket、状态显示、尺寸与输出确认 |
| `src/components/asset-*.tsx` | 资产侧栏和创建表单 |
| `src/components/ssh-connection-dialog.tsx` | SSH 参数与认证表单 |
| `src/components/ui/` | 由官方 CLI 引入的 shadcn/ui 组件 |
| `src/lib/terminal-protocol.ts` | 共享消息类型、参数校验和资源限额 |
| `src/lib/terminal-tabs.ts`、`src/lib/assets.ts` | 标签与资产模型 |
| `server/terminal-plugin.ts` | 将会话服务接入 Vite 开发和预览生命周期 |
| `server/terminal-server.ts` | 来源校验、WebSocket、会话路由与清理 |
| `server/pty-worker.ts` | 在独立 Node.js 进程中持有本地 PTY |
| `server/ssh-session.ts`、`server/known-hosts.ts` | SSH 会话、主机校验与指纹记录 |

```text
React / xterm.js ⇄ 同源 WebSocket ⇄ 本机会话服务
                                    ├─ 子进程 ⇄ node-pty ⇄ 本地 Shell
                                    └─ ssh2 ⇄ SSH 服务器
```

前端不能指定本机可执行文件、参数或工作目录。会话服务只接受约定的协议消息，不提供通用文件访问或命令执行 API。

后台终端保持挂载并继续消费输出。xterm 消费数据后按 UTF-16 单元确认，服务通过高低水位暂停和恢复流；未确认输出、Socket / IPC 缓冲及输入均受限制。具体阈值以共享协议和会话实现为准。

终端服务随所属 HTTP 服务关闭或宿主进程退出清理，不绑定 Vite 单个环境的 `closeBundle`，也不拦截宿主终止信号。修改此行为时需运行生命周期回归测试。

## UI 维护

在 `components.json` 中维护组件路径与基础配置，使用官方 shadcn CLI 添加实际需要的组件，保留上游许可。项目采用 Radix 基础组件；新增迁移方案需要独立技术决策。

主题及终端颜色统一维护在 `src/index.css`。`src/lib/utils.ts` 是组件工具别名的兼容入口，虽未被当前业务代码直接导入，仍由 CLI 配置引用，不按无引用业务文件清理。

## 自动化测试

提交代码前运行：

```sh
npm run check
npm test
npm run build
```

| 测试文件 | 主要覆盖 |
| --- | --- |
| `tests/assets.test.ts` | 资产字段、数量、层级、引用、搜索与存储边界 |
| `tests/terminal-tabs.test.ts` | 标签增删、选择、上限与会话标识 |
| `tests/terminal-server.test.ts` | 来源 / 协议拒绝、真实本地 Shell、尺寸、背压与关闭隔离 |
| `tests/terminal-plugin.test.ts` | Vite 环境关闭、服务重启与宿主信号 |
| `tests/ssh-protocol.test.ts` | SSH 参数、认证内容与指纹响应校验 |
| `tests/ssh-server.test.ts` | 首次信任、指纹变化、认证、流解码、背压与连接隔离 |

测试会在本机启动真实 Shell 和临时 SSH 协议服务，使用临时密钥及独立指纹目录，不依赖外部服务器或个人凭据。运行环境必须允许创建子进程及绑定回环端口；`spawn EPERM` 等权限错误需要结合执行环境判断。

当前没有持续集成或浏览器自动化套件。自动化测试不能替代布局、焦点、后台终端和真实服务器兼容性验证。Windows 已验证；macOS / Linux、真实远端 SSH 与浏览器指纹确认流程仍需单独验收。

## 浏览器交互测试

1. 确认目标端口由本项目 Vite 监听；未启动时执行 `npm run dev` 并等待 ready。请求 `http://127.0.0.1:5173/`，确认 HTTP 200 且页面内容属于 NovaTerminal。
2. 服务就绪后新建内置浏览器标签，例如 `cua.createBrowserTab("iab", "http://127.0.0.1:5173/", { visible: true })`，使用返回的标签绑定，等待工作区加载后交互。
3. 若首次打开时出现 `ERR_CONNECTION_REFUSED`，恢复服务并确认 HTTP 200 后重新新建标签，不用 `getTab` 复用失败标签。错误页可能使用 `data:text/html…` 地址；工具读取该标签时会先触发 URL 策略，导致后续 `goto` 尚未执行即被拦截。此报错不代表应用地址被拒绝，不应放宽错误页协议或项目访问控制。
4. 新建本地终端，等待“运行中”和 Shell 提示符，输入 `echo NOVA_UI_OK` 并按回车，检查独立输出行。随后检查标签增删 / 切换、主题、SSH 认证方式切换及资产表单。需要验证保存和搜索时使用明确的测试数据，并说明数据保留或清理方式。
5. 每次交互后读取最新页面状态；布局验证需截图确认。记录实际完成范围，区分表单显示、配置保存和真实连接。
6. 结束后关闭自己创建的终端、取消未提交表单，恢复临时主题设置；不要关闭他人的会话或停止原有开发服务。

该流程已通过内置浏览器验证页面打开、命令回显、多标签、主题与对话框。预览环境使用 `http://127.0.0.1:4173/`，需先构建并启动 `npm run preview`，再执行同样的服务就绪检查。

## 依赖安全检查

```sh
npm audit --omit=dev --registry=https://registry.npmjs.org
npm audit --registry=https://registry.npmjs.org
```

命令中的 registry 仅影响本次调用，适用于所用镜像未提供审计接口的情况。

2026-10-18 对当前锁文件的审计：运行依赖报告 0 项漏洞；完整依赖报告 7 项高危告警，均涉及 shadcn 开发工具的 `braces` 依赖链。[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) 当时未列出修复版本。保留现有依赖，待兼容修复后更新并复测；不要直接采用审计建议的跨主版本降级。该结果随依赖与数据库变化，发布前需重新检查。

## 文档与许可

README 面向使用者，本文维护开发与验证方法，`docs/ai-context.md` 仅保留后续协作需要的状态和决策。`docs/plans/` 用于跨模块任务的范围、验收和进度，完成后将有效决策整合进长期文档，删除重复过程记录。

依赖、组件、模板与字体的上游许可保存在 `THIRD_PARTY_NOTICES.txt` 和 `licenses/`。精简文档时保留原始版权与许可文本，不能将其视为重复说明删除。
