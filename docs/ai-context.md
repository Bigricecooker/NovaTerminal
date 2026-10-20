# 项目维护上下文

更新日期：2026-10-20。

## 文档职责

- [README](../README.md)：功能、运行要求与使用入口。
- [开发指南](development.md)：模块职责、生命周期、构建和测试方法。
- [贡献指南](../CONTRIBUTING.md)：变更流程与 Conventional Commits。
- [安全说明](../SECURITY.md)：本地服务、凭据、主机信任与漏洞报告。
- [AGENTS.md](../AGENTS.md)：统一 AI 协作规则，不在其他工具目录复制规则。

本文件只维护会影响后续开发的状态、约束和决策，不保存聊天历史、工具调用日志或已完成的实施流水。

个人操作、本机排障和单次验收记录保留在已忽略的 `docs/local/`，不进入远程仓库。

## 实现与边界

- 当前为 Electron 桌面运行时、Vite + React + TypeScript 界面，仅维护桌面运行模式。已有本地 PTY、SSH 直连、多标签、资产分组 / 搜索及深浅主题。
- 本地 / SSH 共用 4 标签上限；后台会话保持挂载。关闭仅清理所属会话，Shell 自行退出后保留标签供查看。
- SSH 首次主机指纹须明确确认，变化或记录异常时拒绝；不保存认证秘密，不自动重连或重放命令。资产仅持久化公开连接配置。
- 已提供 Windows x64 可运行目录包，包含运行时，不依赖 Vite 或系统 Node.js；安装器、签名和自动更新未实现。
- 跳板机、SSH Agent、交互式多因素认证、文件传输、凭据存储和远端管理未实现。资产尚无编辑、删除、导入 / 导出。

## 技术决策

- 使用 npm 和 `package-lock.json`，Node.js / npm 版本范围以 `package.json` 为准。安装使用 `npm ci`。
- 源码按 `src/main` / `src/preload` / `src/renderer` / `src/server` / `src/shared` 分层。Vite 根目录为 `src/renderer`，界面源码位于 `src/renderer/src`；`@` 指向界面源码，`@shared` 指向跨进程协议。构建产物为 `out/electron/` 和仓库根目录 `dist/`。
- UI 使用 shadcn 官方 CLI，当前基础为 Radix / Nova；统一主题 tokens，保留上游源码与许可。`.agents/skills/shadcn/` 为在用协作技能，来源由 `skills-lock.json` 记录。
- `components.json` 的工具别名仍引用 `src/renderer/src/lib/utils.ts`，保留此兼容入口。字体从依赖包本地分发。
- 桌面使用沙箱 renderer、受限 preload、校验来源 / 主框架 / 参数 / 归属的 IPC，以及每会话 utility process。PTY / SSH 的核心工作进程共用；原生代码不进入前端包。
- `npm run dev` 启动桌面和 `127.0.0.1:5180` 热更新页面，保留 Electron DevTools 调试。独立浏览器运行模式、WebSocket 终端服务、`dev:web` 和 `preview` 已移除；开发和构建后的应用共用 preload / IPC / utility process。普通浏览器打开页面仅提示使用桌面应用。
- Windows GUI 启动必须保持 `windowsHide: false`，避免首次显示被隐藏；桌面冒烟检查窗口可见且未最小化，不能仅依赖页面加载、进程或截图成功。
- 桌面使用无系统边框窗口，三个窗口按钮与应用操作共用 48px React 页头、主题及布局，不再使用原生 Window Controls Overlay 或颜色同步 IPC。页头可拖动，操作组为 `no-drag`；受限 `novaWindow` 仅提供固定窗口操作及最大化状态读取 / 订阅，校验来源、主框架和动作白名单。
- 顶栏下方使用全宽 Separator；应用操作与窗口按钮之间设置贯穿顶栏高度的竖分割线。终端标签下直接显示输出区域，不设清屏工具栏；Shell 与连接状态集中在底部状态栏。
- 桌面构建通过 `app://novaterminal/` 加载包内资源，设置 CSP 并禁止外部导航和页面权限；不监听 HTTP / WebSocket。Vite 仅在开发期提供回环热更新页面，静态 `dist/` 无法独立提供终端。`ws` 仅为开发 / 目录包测试依赖。
- Electron、打包工具和 esbuild 固定版本；ASAR 解包原生模块及 ConPTY 所需文件。新增运行时保留 Electron / Chromium 许可；更换平台或原生依赖时重新验证。
- 桌面正式资源和桌面开发站点资产存储隔离，不自动迁移；主机指纹沿用已有平台目录，不保存认证秘密。旧浏览器站点存储不自动读取。
- 输入输出保持有界缓冲、UTF-16 ACK 和背压；资源限额以共享协议及服务实现为准。
- 粘贴分块保留完整 UTF-16 代理对，避免 PTY / SSH 分别编码输入时破坏 emoji。主机指纹通过同目录临时文件和硬链接原子发布，不覆盖已存在记录；独立会话同时确认相同指纹可成功，不同指纹竞争或异常记录仍拒绝。文件系统不支持硬链接时首次信任失败关闭。
- Git 初始分支为 `main`；提交规范集中维护于贡献指南，尚未配置提交钩子。实际提交与远端状态以 Git 为准。

## 验证要求与待覆盖范围

- 自动化覆盖资产、标签、桌面会话链路下的真实 PTY / 临时 SSH、来源 / 协议、背压、桌面开发页面、窗口动作白名单、独立指纹存储并发及 Unicode 输入分块；具体命令和覆盖见开发指南。系统 Node.js 测试进程适配仅位于 `tests/`。
- 桌面变更需运行真实 Electron 冒烟；目录包需单独运行 `test:package`，不能用系统 Node.js 测试或开发 Electron 代替独立 exe 验收。
- 窗口按钮鼠标输入和最大化状态同步由 Electron 冒烟覆盖；人工鼠标拖动、系统贴靠、后台 xterm 输出 / 焦点、真实远端 SSH 和 macOS / Linux 兼容性仍需专项验证。自绘最大化按钮不提供原生悬停贴靠菜单。
- 尚无持续集成；本机单次通过记录不作为其他平台或后续改动的验收结论。
- 依赖审计按开发指南执行；不将运行依赖审计通过描述为全项目无漏洞。
