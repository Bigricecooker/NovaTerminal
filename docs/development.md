# 开发指南

## 环境与依赖

使用 Node.js `>=24.19.0 <25` 和 npm `>=11.19.1 <12`，在仓库根目录执行 `npm ci`。版本以 `package-lock.json` 为准；依赖变更需同步锁文件。

`node-pty` 是原生模块。若目标平台没有匹配的预构建文件，需要按安装错误和上游构建要求准备工具链。项目 `allowScripts` 允许锁定版本的 `node-pty` 和 esbuild 安装脚本；`ssh2` 的可选原生加速脚本保持禁用。调整版本时一并检查脚本许可，不修改全局 npm 配置。

主要技术栈为 Electron、Vite、React、TypeScript、Tailwind CSS、shadcn/ui、xterm.js、node-pty 和 ssh2。Electron 及打包工具使用精确版本，运行时首次使用时按上游下载机制获取。打包使用该版本 npm 包提供的 SHA-256 清单验证缓存或下载内容，已有有效缓存时无需重新下载校验清单；网络失败时先检查下载与校验错误，不关闭校验。

## 桌面开发与打包

```sh
npm run dev
```

该命令编译主进程、preload 和会话进程，在 `127.0.0.1:5180` 启动桌面专用 Vite 页面，再打开 Electron。此模式不加载 WebSocket 终端插件。前端支持热更新；修改 `src/main/`、`src/preload/` 或会话服务后重启命令。启动器退出时请求应用清理会话并关闭自己创建的 Vite 服务。

Windows 桌面启动使用 `windowsHide: false`。将 GUI 进程以隐藏方式启动，可能使首次 `BrowserWindow.show()` 后窗口仍不可见，即使页面已加载且进程正常运行。桌面冒烟测试同时检查窗口可见和未最小化，不能仅以进程存在或页面可截图作为显示成功的依据。启动器打印开发地址与桌面启动提示，异常启动或退出会显示错误。

```sh
npm run build
npm start
npm run package
npm run test:package
```

构建产物分别为 `dist/` 和 `out/electron/`。`npm start` 使用构建产物，`npm run package` 生成当前平台、当前架构的可运行目录。Windows x64 入口为 `release/NovaTerminal-win32-x64/NovaTerminal.exe`，运行无需系统 Node.js 或 Vite；分发时保留整个目录。当前不生成安装器，不签名，不自动更新。

打包使用 ASAR，原生 `.node` 文件和 `node-pty` 所需的 ConPTY DLL / 辅助程序保留在解包目录。当前锁定的 `node-pty` 使用 N-API，已验证 Windows x64 的 Electron 加载和独立 exe 终端；升级 Electron、原生依赖或切换平台后必须重新验证，不以系统 Node.js 测试代替桌面原生模块测试。

`test:package` 将完整目录复制到独立临时位置，使用空白用户数据目录、去除系统 Node.js 的 PATH，启动真实 exe。仅测试启动参数开启回环调试端口，测试结束后关闭程序并清理临时目录；普通启动不开启该端口。测试检查包内页面、preload、本地命令、主题及 Shell 随应用退出。

本次 Windows 环境中，复制后的同一 Electron 二进制在工作区内会于应用代码执行前退出，状态为 `0x80000003`；同一完整包在临时目录中通过验证。该状态本身不能确定根因。若遇到相同现象，先对比整个目录包在普通可读写目录中的运行结果及系统安全日志，保持 renderer 沙箱和上下文隔离开启。

## 代码组织

源码按运行时划分为 `src/main`、`src/preload`、`src/renderer`、`src/server` 和 `src/shared`。Vite 根目录为 `src/renderer`，界面源码位于 `src/renderer/src`；`@` 指向界面源码，`@shared` 指向共享协议。共享协议不依赖 Electron、Node.js 或 React 的运行时能力。

浏览器 PTY worker 相对于 `src/server/terminal-plugin.ts` 定位，不依赖 Vite 页面根目录或配置文件位置。桌面入口通过 esbuild 输出到 `out/electron/`，前端构建输出到仓库根目录 `dist/`。

桌面使用 `titleBarStyle: hidden` 与原生 Window Controls Overlay，将窗口按钮融入 48px 应用页头。内容通过 `titlebar-area-x` / `titlebar-area-width` CSS 环境变量避让原生按钮，页头为拖动区，操作按钮组为 `no-drag`。浏览器模式保持普通页头；窗口颜色由界面主题 tokens 转为 RGB，经独立、有限且校验来源与参数的 `novaWindow.setAppearance` 同步。

页头下方的水平 Separator 独立于 48px 原生叠加区域，保证窗口按钮下方的线条连续；操作组使用竖直 Separator。终端不设独立清屏工具栏，Shell、连接状态和错误提示保留在底部状态栏。

| 位置 | 职责 |
| --- | --- |
| `src/renderer/src/App.tsx` | 页面布局、主题和工作区加载 |
| `src/renderer/src/components/terminal-workspace.tsx` | 标签状态、终端入口和临时凭据交接 |
| `src/renderer/src/components/terminal-session.tsx` | xterm、会话状态、尺寸与输出确认 |
| `src/renderer/src/lib/terminal-transport.ts` | 桌面 preload 与浏览器 WebSocket 传输适配 |
| `src/renderer/src/components/asset-*.tsx` | 资产侧栏和创建表单 |
| `src/renderer/src/components/ssh-connection-dialog.tsx` | SSH 参数与认证表单 |
| `src/renderer/src/components/ui/` | 由官方 CLI 引入的 shadcn/ui 组件 |
| `src/shared/terminal-protocol.ts` | 共享消息类型、参数校验和资源限额 |
| `src/renderer/src/lib/terminal-tabs.ts`、`src/renderer/src/lib/assets.ts` | 标签与资产模型 |
| `src/server/terminal-plugin.ts` | 将会话服务接入 Vite 开发和预览生命周期 |
| `src/server/terminal-server.ts` | 来源校验、WebSocket、会话路由与清理 |
| `src/main/index.ts`、`src/preload/index.ts` | 桌面窗口、本地资源协议和受限桥接 |
| `src/main/security.ts`、`src/main/sessions.ts` | IPC 来源 / 参数 / 归属校验、会话限额与清理 |
| `src/server/session-worker.ts` | 独立进程持有本地 PTY 或 SSH 会话，共用协议及背压 |
| `src/server/pty-worker.ts`、`src/main/session-worker.ts` | Node.js 子进程与 Electron utility process 的消息适配 |
| `src/server/ssh-session.ts`、`src/server/known-hosts.ts` | SSH 会话、主机校验与指纹记录 |

```text
桌面：React / xterm.js ⇄ 沙箱 preload ⇄ 主进程 IPC 校验
                                      └─ 每会话 utility process ⇄ node-pty / ssh2
浏览器：React / xterm.js ⇄ 同源 WebSocket ⇄ 本机会话服务
                                          ├─ 子进程 ⇄ node-pty
                                          └─ ssh2
```

前端不能指定本机可执行文件、参数或工作目录。会话服务只接受约定的协议消息，不提供通用文件访问或命令执行 API。

后台终端保持挂载并继续消费输出。xterm 消费数据后按 UTF-16 单元确认，服务通过高低水位暂停和恢复流；未确认输出、Socket / IPC 缓冲及输入均受限制。具体阈值以共享协议和会话实现为准。

粘贴输入使用共享分块函数，在协议长度限制内保留完整 UTF-16 代理对，避免 PTY / SSH 分别编码各块时破坏 emoji。

桌面会话属于创建它的窗口；刷新、渲染进程退出或关闭窗口会清理所属会话。应用正常退出时先请求会话进程关闭，再限时等待退出；关闭中的进程在退出前仍占用资源名额。浏览器终端服务随所属 HTTP 服务关闭或宿主进程退出清理，不绑定 Vite 单个环境的 `closeBundle`，也不拦截宿主终止信号。修改这些行为时需运行生命周期回归测试。

## UI 维护

在 `components.json` 中维护组件路径与基础配置，使用官方 shadcn CLI 添加实际需要的组件，保留上游许可。项目采用 Radix 基础组件；新增迁移方案需要独立技术决策。

主题及终端颜色统一维护在 `src/renderer/src/index.css`。`src/renderer/src/lib/utils.ts` 是组件工具别名的兼容入口，虽未被当前业务代码直接导入，仍由 CLI 配置引用，不按无引用业务文件清理。

## 自动化测试

提交代码前运行：

```sh
npm run check
npm test
npm run build
npm run test:desktop
```

| 测试文件 | 主要覆盖 |
| --- | --- |
| `tests/assets.test.ts` | 资产字段、数量、层级、引用、搜索与存储边界 |
| `tests/terminal-tabs.test.ts` | 标签增删、选择、上限与会话标识 |
| `tests/terminal-server.test.ts` | 来源 / 协议拒绝、真实本地 Shell、尺寸、背压与关闭隔离 |
| `tests/terminal-plugin.test.ts` | 实际 Vite 配置的页面 / PTY、环境关闭、服务重启与宿主信号 |
| `tests/ssh-protocol.test.ts` | SSH 参数、认证内容与指纹响应校验 |
| `tests/terminal-input.test.ts` | 分块边界的 Unicode 完整性、独立 UTF-8 编码及协议长度限制 |
| `tests/ssh-server.test.ts` | 首次信任、指纹变化、认证、流解码、背压与连接隔离 |
| `tests/desktop-security.test.ts` | 桌面来源、主框架、资源路径、会话归属、限额、ACK 和隔离清理 |

`test:desktop` 启动真实 Electron，检查窗口可见性、顶栏安全区域 / 拖动区域样式、最小化 / 最大化 / 关闭、原生主题颜色同步、沙箱配置、preload、本地 PTY、命令输入、多标签、窗口尺寸、SSH 首次指纹确认、密码认证、跨分块 emoji 粘贴及退出清理。窗口状态通过 Electron API 验证，系统按钮的真实鼠标点击和拖动仍需人工检查。开发页面模式可用 `node scripts/test-desktop.mjs --dev` 验证；包内 ASAR 可用 `node scripts/test-desktop.mjs release/NovaTerminal-win32-x64/resources/app.asar/out/electron/main.cjs` 验证。ASAR 检查复用开发 Electron，不替代独立 exe 的 `test:package`。

测试会在本机启动真实 Shell 和临时 SSH 协议服务，使用临时密钥及独立指纹目录，不依赖外部服务器或个人凭据。运行环境必须允许创建子进程及绑定回环端口；`spawn EPERM` 等权限错误需要结合执行环境判断。

当前没有持续集成或独立浏览器自动化套件。自动化测试不能替代布局、焦点、后台终端和真实服务器兼容性验证。Windows x64 已验证；macOS / Linux、真实远端 SSH 与浏览器指纹确认流程仍需单独验收。冒烟截图保存在忽略提交的 `test-results/` 中。

## 浏览器交互测试

1. 确认目标端口由本项目 Vite 监听；未启动时执行 `npm run dev:web` 并等待 ready。请求 `http://127.0.0.1:5173/`，确认 HTTP 200 且页面内容属于 NovaTerminal。
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
