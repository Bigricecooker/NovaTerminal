# 项目维护上下文

更新日期：2026-10-19。

## 文档职责

- [README](../README.md)：功能、运行要求与使用入口。
- [开发指南](development.md)：模块职责、生命周期、测试和内置浏览器故障恢复方法。
- [贡献指南](../CONTRIBUTING.md)：变更流程与 Conventional Commits。
- [安全说明](../SECURITY.md)：本地服务、凭据、主机信任与漏洞报告。
- [AGENTS.md](../AGENTS.md)：统一 AI 协作规则，不在其他工具目录复制规则。

本文件只维护会影响后续开发的状态、约束和决策，不保存聊天历史、工具调用日志或已完成的实施流水。

## 实现与边界

- 当前为 Electron 桌面运行时、Vite + React + TypeScript 界面，并保留浏览器开发模式。已有本地 PTY、SSH 直连、多标签、资产分组 / 搜索及深浅主题。
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
- `npm run dev` 启动桌面和 `127.0.0.1:5180` 页面；`npm run dev:web` 保留 `127.0.0.1:5173` 浏览器服务。桌面开发模式不启用 WebSocket 终端插件。
- Windows GUI 启动必须保持 `windowsHide: false`，避免首次显示被隐藏；桌面冒烟检查窗口可见且未最小化，不能仅依赖页面加载、进程或截图成功。
- 桌面原生窗口按钮通过 Window Controls Overlay 融入 48px 应用页头，CSS 环境变量保留按钮安全区域，操作按钮组排除拖动。受限 `novaWindow.setAppearance` 仅同步两个 RGB 颜色并校验来源 / 主框架 / 参数；浏览器模式不启用窗口能力。
- 顶栏下方使用独立、全宽的 Separator，避开原生窗口按钮叠加层；连接与主题按钮同组，仅在应用操作与窗口按钮之间设置贯穿顶栏高度的竖分割线。终端标签下直接显示输出区域，不设清屏工具栏；Shell 与连接状态集中在底部状态栏。
- 桌面构建通过 `app://novaterminal/` 加载包内资源，设置 CSP 并禁止外部导航和页面权限；不监听 HTTP / WebSocket。浏览器开发及预览才提供本机会话服务，仅支持 `http://127.0.0.1`；静态 `dist/` 无法独立提供终端。
- Electron、打包工具和 esbuild 固定版本；ASAR 解包原生模块及 ConPTY 所需文件。新增运行时保留 Electron / Chromium 许可；更换平台或原生依赖时重新验证。
- 桌面正式资源、桌面开发站点和浏览器站点资产存储隔离，不自动迁移；主机指纹沿用已有平台目录，不保存认证秘密。
- 服务清理绑定 HTTP 关闭及进程退出，不绑定单个 Vite 环境的 `closeBundle`，不拦截宿主终止信号。
- 输入输出保持有界缓冲、UTF-16 ACK 和背压；资源限额以共享协议及服务实现为准。
- 粘贴分块保留完整 UTF-16 代理对，避免 PTY / SSH 分别编码输入时破坏 emoji。
- Git 初始分支为 `main`；提交规范集中维护于贡献指南，尚未配置提交钩子。实际提交与远端状态以 Git 为准。

## 验证与待验收范围

- Windows x64 上 `npm run check`、`npm run build` 与全部 40 项 `npm test` 通过，覆盖资产、标签、真实 PTY、来源 / 协议、背压、实际 Vite 页面 / PTY、Vite 生命周期、临时 SSH 和桌面 IPC 边界。
- 真实 Electron 的生产资源、开发页面和包内 ASAR 冒烟通过，覆盖本地终端、输入、多标签、主题、尺寸与 SSH 首次信任 / 密码认证。独立目录 exe 在去除系统 Node.js 的 PATH 下通过页面、preload、PTY、输入、主题和退出清理测试。
- 本次环境中，同一完整目录包在工作区内以 `0x80000003` 提前退出，在独立临时目录正常运行；根因尚未确定。`test:package` 在独立目录验收，不通过关闭沙箱解决。复测方法见开发指南。
- 内置浏览器已验证页面、本地命令回显、多标签增删、主题、SSH 密码 / 私钥表单及资产创建表单；另有浏览器资产保存 / 搜索实测。尚无可重复运行的浏览器自动化套件或 CI。
- 真实远端 SSH、浏览器主机指纹确认、后台 xterm 输出 / 焦点与 macOS / Linux 仍需独立验收。
- 当前完整依赖审计存在开发工具链告警，详情与复查命令见开发指南；不将运行依赖审计通过描述为全项目无漏洞。
