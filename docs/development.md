# 开发指南

## 环境与依赖

使用 Node.js `>=24.19.0 <25` 和 npm `>=11.19.1 <12`，在仓库根目录执行 `npm ci`。版本以 `package-lock.json` 为准；依赖变更需同步锁文件。

`node-pty` 是原生模块。若目标平台没有匹配的预构建文件，需要按安装错误和上游构建要求准备工具链。项目 `allowScripts` 允许锁定版本的 `node-pty` 和 esbuild 安装脚本；`ssh2` 的可选原生加速脚本保持禁用。调整版本时一并检查脚本许可，不修改全局 npm 配置。

主要技术栈为 Electron、Vite、React、TypeScript、Tailwind CSS、shadcn/ui、xterm.js、node-pty 和 ssh2。Electron 及打包工具使用精确版本，运行时首次使用时按上游下载机制获取。打包使用该版本 npm 包提供的 SHA-256 清单验证缓存或下载内容，已有有效缓存时无需重新下载校验清单；网络失败时先检查下载与校验错误，不关闭校验。

## 桌面开发与打包

```sh
npm run dev
```

该命令编译主进程、preload 和会话进程，在 `127.0.0.1:5180` 启动 Vite 页面，再打开 Electron。前端支持热更新，开发期按 F12 或 Windows / Linux 的 Ctrl+Shift+I、macOS 的 Cmd+Alt+I 切换 DevTools；修改 `src/main/`、`src/preload/` 或会话服务后重启命令。启动器收到退出信号时请求应用退出，保留 Vite 直至应用结束；用户取消后允许再次请求，不用固定超时强杀正在等待确认的应用。开发与正式模式均通过 preload / IPC 访问会话，不提供独立浏览器模式或终端 WebSocket 服务。

Windows 桌面启动使用 `windowsHide: false`。将 GUI 进程以隐藏方式启动，可能使首次 `BrowserWindow.show()` 后窗口仍不可见，即使页面已加载且进程正常运行。桌面冒烟测试同时检查窗口可见和未最小化，不能仅以进程存在或页面可截图作为显示成功的依据。启动器打印开发地址与桌面启动提示，异常启动或退出会显示错误。

```sh
npm run build
npm start
npm run package
npm run test:package
```

构建产物分别为 `dist/` 和 `out/electron/`。`npm start` 使用构建产物，`npm run package` 生成当前平台、当前架构的可运行目录。Windows x64 入口为 `release/NovaTerminal-win32-x64/NovaTerminal.exe`，运行无需系统 Node.js 或 Vite；分发时保留整个目录。当前不生成安装器，不签名，不自动更新。

打包使用 ASAR，原生 `.node` 文件和 `node-pty` 所需的 ConPTY DLL / 辅助程序保留在解包目录。当前锁定的 `node-pty` 使用 N-API；升级 Electron、原生依赖或切换平台后必须验证桌面原生模块加载和独立 exe 终端，不以系统 Node.js 测试代替。

`test:package` 将完整目录复制到独立临时位置，通过 `--user-data-dir` 显式指定隔离目录，预置字号哨兵并断言初始快照，去除系统 Node.js 的 PATH 后启动真实 exe。仅修改 APPDATA 不能证明 Electron 的用户数据隔离。测试启动参数开启回环调试端口，测试结束后关闭程序并清理临时目录；普通启动不开启该端口。测试检查包内页面、preload、本地命令、设置读取 / 保存、主题、退出取消 / 重试及 Shell 随应用退出；随后重启独立 exe，检查外观和会话偏好恢复，再损坏隔离配置后启动，检查默认值、警告与原始损坏文件备份。

同一用户数据目录只允许一个主进程：入口在初始化存储和窗口前调用 Electron 单实例锁，第二实例直接退出，由原实例恢复最小化窗口并显示、聚焦。不同目录可以独立运行。开发与正式数据虽分区存储，但共用用户数据目录时仍受同一把锁约束。

## 代码组织

源码按运行时划分为 `src/main`、`src/preload`、`src/renderer`、`src/server` 和 `src/shared`。Vite 根目录为 `src/renderer`，界面源码位于 `src/renderer/src`；`@` 指向界面源码，`@shared` 指向共享协议。共享协议不依赖 Electron、Node.js 或 React 的运行时能力。

桌面入口通过 esbuild 输出到 `out/electron/`，前端构建输出到仓库根目录 `dist/`。二者及 `release/` 均是生成产物，源码只维护一套。`src/server/` 保存会话进程核心，不监听网络服务。

桌面使用无系统边框窗口，最小化、最大化 / 还原、关闭按钮由 `window-controls.tsx` 绘制，与应用操作处于同一 48px React 页头，共用主题 tokens。页头为拖动区，操作按钮组为 `no-drag`。受限 `novaWindow` 仅提供三个固定窗口操作和最大化状态读取 / 订阅；主进程继续校验来源、主框架和动作白名单，原生状态变化同步回界面。窗口按钮无需独立颜色同步或原生叠加层安全区域。

页头下方使用全宽水平 Separator；应用操作与窗口操作之间使用竖直 Separator。终端不设独立清屏工具栏，Shell、连接状态和错误提示保留在底部状态栏。

| 位置 | 职责 |
| --- | --- |
| `src/renderer/src/App.tsx` | 页面布局、主题和工作区加载 |
| `src/renderer/src/components/terminal-workspace.tsx` | 标签状态、连接入口和资产名称同步 |
| `src/renderer/src/components/terminal-session.tsx` | xterm、会话状态、尺寸与输出确认 |
| `src/renderer/src/lib/terminal-transport.ts` | preload 会话传输、待发送量与订阅清理 |
| `src/renderer/src/components/window-controls.tsx` | 页头窗口按钮和最大化状态同步 |
| `src/renderer/src/components/asset-*.tsx` | 资产树、创建 / 编辑、重命名 / 移动 / 删除对话框与右键菜单 |
| `src/renderer/src/components/ssh-connection-fields.tsx` | 创建 / 编辑 SSH 连接的参数与认证表单 |
| `src/main/credential-store.ts` | 有界加密凭据存储、端点绑定及删除，系统保护能力由主进程注入 |
| `src/renderer/src/components/ui/` | 由官方 CLI 引入的 shadcn/ui 组件 |
| `src/shared/terminal-protocol.ts` | 共享消息类型、参数校验和资源限额 |
| `src/renderer/src/lib/terminal-tabs.ts`、`src/shared/assets.ts` | 标签与共享资产模型；原 renderer 资产文件保留兼容导出 |
| `src/shared/settings.ts`、`src/main/settings-store.ts` | 设置字段 / 平台校验、默认值、持久化与损坏恢复 |
| `src/server/local-shell.ts` | 平台 Shell 白名单与实际路径解析 |
| `src/main/exit-coordinator.ts` | 退出请求去重、界面应答超时和取消 |
| `src/shared/connection-transfer.ts` | 公开配置导出、导入校验和预览合并 |
| `src/shared/terminal-interactions.ts` | 快捷键 / IME 守卫、剪贴板上限及外链校验 |
| `src/renderer/src/components/settings-dialog.tsx`、`terminal-search.tsx` | 设置草稿表单与每标签搜索 |
| `src/main/index.ts`、`src/preload/index.ts` | 桌面窗口、本地资源协议和受限桥接 |
| `src/main/security.ts`、`src/main/sessions.ts` | IPC 来源 / 参数 / 归属校验、会话限额与清理 |
| `src/server/session-worker.ts` | 独立进程持有本地 PTY 或 SSH 会话，共用协议及背压 |
| `src/main/session-worker.ts` | Electron utility process 的消息适配 |
| `src/server/ssh-session.ts`、`src/server/known-hosts.ts` | SSH 会话、主机校验与指纹记录 |

```text
React / xterm.js ⇄ 沙箱 preload ⇄ 主进程 IPC 校验
                                └─ 每会话 utility process ⇄ node-pty / ssh2
```

前端不能指定本机可执行文件或参数。设置只接受平台 Shell 枚举，本地连接只接受有界绝对工作目录；主进程按保存设置选取 Shell，会话进程验证目录与 Shell 是否可用。会话服务只接受约定的协议消息，不提供通用文件访问或独立命令执行 API。

后台终端保持挂载并继续消费输出。xterm 消费数据后按 UTF-16 单元确认，服务通过高低水位暂停和恢复流；未确认输出、Socket / IPC 缓冲及输入均受限制。具体阈值以共享协议和会话实现为准。

粘贴输入使用共享分块函数，在协议长度限制内保留完整 UTF-16 代理对，避免 PTY / SSH 分别编码各块时破坏 emoji。主机指纹先写入同目录临时文件，再以硬链接原子发布完整记录；跨会话 / 进程同时确认相同指纹可成功，竞争中的不同指纹或异常记录继续拒绝。文件系统不支持硬链接时阻止首次信任，不退回可能覆盖旧记录的写法；异常中止可能留下仅含公开主机信息的 `.tmp` 文件，它们不会作为信任记录读取。

桌面会话属于创建它的窗口；刷新、渲染进程退出或关闭窗口会清理所属会话。应用正常退出时先请求会话进程关闭，再限时等待退出；关闭中的进程在退出前仍占用资源名额。修改这些行为时需运行生命周期回归测试。

## 设置与终端生命周期

设置存储使用用户数据目录 `settings/desktop.json` 或开发模式的 `settings/development.json`，格式为 `{version:1,values:{…}}`，读取上限 64 KiB。共享解析器填补缺失字段、剥离未知字段并拒绝无效值。写入同目录临时文件、fsync、rename 成功后才替换内存；损坏文件尝试重命名隔离并提示，首次缺文件正常使用默认值。preload 同步获取受来源校验的初始快照，React 挂载前应用主题，后续通过订阅接收设置和系统主题变化。

外观更新修改已有 xterm options 并重新适配尺寸，不重建会话。Shell / 默认目录用于新建；显式本地资产目录优先。上限默认 4、范围 1–8，renderer 对所有保留标签计数，主进程对待启动、运行和正在关闭的资源计数。降低上限不清理存量，回收未完成可能暂时拒绝新建。

退出入口统一交给 `exit-coordinator`，请求带递增编号。界面有活动会话时确认，无活动会话直接应答退出；取消之前不清理资源。主进程每秒探测一次，5 秒内没有界面 ACK 才按失联处理，不限制用户考虑时长。陈旧编号忽略；渲染崩溃、刷新、系统关机或进程强杀不承诺确认。标签显式重连递增 generation，沿用标签 ID、清空旧输出；SSH 重新读取当前认证引用，端点变更或资产已删除拒绝重连，不重放输入。

剪贴板通过受限主进程 API 读写；输入先检查 65,536 个 UTF-16 单元限制，再由 `terminal.paste` 保留 bracketed paste 语义。超限只提示。复制上限 1,048,576 个单元；选中即复制在鼠标释放 / 键盘选择稳定后执行。多行确认不显示内容，销毁时取消待处理粘贴。清屏先清除搜索装饰与选区，再调用 `terminal.clear()`，避免不可见选区拦截下一次 Ctrl+C。

普通搜索使用锁定版本的 SearchAddon，每标签保存当前搜索状态。正则表达式只在独立 Worker 中编译与执行，500ms 内未完成则终止并提示；更改查询、关闭搜索、清屏或销毁终端也会取消。快照按软换行合并，最多 4,194,304 个 UTF-16 单元，每 128 行让出界面线程；超限拒绝整次正则搜索，内容或尺寸变化丢弃旧结果。匹配位置通过 xterm 稳定缓冲区 / cell API 转换为选区，保持 proposed API 关闭；空查询和关闭清除选区。WebLinksAddon 与 OSC 8 共用 URL 验证，只有 http/https 可调用受限 `shell.openExternal`。右键、终端鼠标报告修饰键及合成输入由 UI 入口检查。

导入 / 导出只经系统文件对话框，renderer 无法提交文件路径。主进程最多读取 1 MiB，校验公开格式；合并预览再次校验最终资产文档，确认时检查资产未变化，持久化成功后才更新 UI。同路径同名分组合并，连接保留，新增条目生成 ID；缺失父分组归顶层。导入 SSH 标记 `needsAuthentication`，编辑保存新认证后移除；不读取或导入文件中的认证及引用。导出通过白名单构造公共字段并原子替换用户选定文件。

交换格式沿用资产 / 协议边界：名称最多 80、SSH 用户名 128、本地目录 4096 个 UTF-16 单元，资产最多 500 项、分组最多 8 层。文件的 1 MiB 字节上限与最终工作区文档的 524,288 个 UTF-16 单元上限分别校验，不互相替代；校验实现见 `src/shared/assets.ts` 与 `src/shared/connection-transfer.ts`。

## UI 维护

资产侧栏将资产与展开 / 当前层级状态作为同一工作区文档保存到 `novaterminal.assets.v1`。SSH 沿用 `connection` 类型，本地目录使用 `local` 类型；只保存公开配置。`parentId: null` 的分组和连接共用顶层列表，分组优先、同类按创建顺序排列；“未分组”仅是连接分组选项，不创建同名节点、容器或 ID。列表空白处提供顶层拖放目标，点击空白处清除当前分组选择。旧版文档兼容读取，默认不展开；新状态只保留有效分组 ID。所有资产变更和持久展开状态先保存再更新 React 状态，失败时保留原文档与界面。搜索使用独立的临时展开状态，清除搜索不会展开其他分组。

工具栏新建 SSH 默认“未分组”，分组右键菜单“添加连接”默认该分组，均可手动调整；支持仅保存或保存并连接，两种方式均需填写认证信息。通过 `novaCredentials.save()` 将密码 / 私钥加密保存，认证字段不进入资产文档；安全存储失败时不新增资产，公开配置保存失败时回滚凭据。本地连接通过 `novaDirectories.pick()` 调用无参数目录选择 IPC，主进程限制单次选择并校验来源；取消时不创建连接。资产保存成功后才打开指定目录的固定 Shell，会话进程校验绝对路径与真实目录，失效时明确报错。

`AssetEditDialog` 复用 SSH 字段和分组选项，支持修改连接名称、分组、端点及本地目录。SSH 默认保留认证；端点变化需重新填写认证，秘密不回填。更换认证采用独立加密记录：资产 `id` 保持不变，可选公开字段 `credentialId` 指向当前记录，旧文档缺省使用资产 ID。先保存新记录，再原子保存资产文档，失败清理新记录；成功清理旧记录，清理失败单独提示。主进程最多允许 501 条记录，为 500 项资产预留一次替换空间。引用执行格式与唯一性校验；删除资产按有效引用清理，移动和重命名保持引用。

资产连接使用双击或 Enter / 空格直接打开，单击只更新当前分组层级。SSH 悬停显示用户名@主机，标签使用连接名称。标签分别保留用于名称同步的资产 ID，以及启动时的公开端点 / 凭据引用；`sync-assets` 仅更新名称并保持 `target` 对象，避免触发 `TerminalSession` 重连，本地目录修改也只用于新会话。`start.savedSsh.assetId` 使用有效凭据引用，在主进程校验归属后解析为会话启动参数；秘密不返回 renderer，worker 拒绝未解析的引用。安全存储使用 `safeStorage`，拒绝 Linux 明文后端，开发 / 正式记录隔离；详细边界见安全说明。旧资产或损坏记录在终端中明确报错，可通过编辑重新填写认证。

页面成功读取并校验资产后，通过受限 `novaCredentials.recover()` 提交公开文档。主进程再次验证引用，清理无引用的自身密文记录和临时文件；每次加载仅执行一次，完成前拒绝新认证写入。读取错误不执行清理，恢复失败提示并阻止新认证保存。这样可回收公开配置提交前留下的新记录，也可回收提交后尚未删除的旧记录；仍被已提交资产引用的记录保留，不依赖解密能力。

真实 Electron 冒烟验证单击无弹窗 / 无会话、双击仅打开一次、键盘操作、会话上限、加密记录不含明文、锁定安全存储失败、公开资产保存失败回滚、重新加载免填连接和删除清理。单元测试覆盖密码 / 私钥记录恢复、端点绑定、损坏 / 超限 / 路径输入和会话归属；原生系统安全存储由真实 Electron 验证。

资产排序保持分组优先、同类创建顺序；移动只改 `parentId`，不改变源数组顺序。模型统一校验重命名、子树移动和删除，移动必须验证后代深度与循环。原生 HTML 拖放仅传递条目 ID，并核对页面内拖拽来源；右键菜单的“移动到”提供键盘替代。会话标签拖动与键盘排序只更新 reducer 中的数组，保留原标签对象和终端组件，不触发连接建立或持久化凭据。

在 `components.json` 中维护组件路径与基础配置，使用官方 shadcn CLI 添加实际需要的组件，保留上游许可。项目采用 Radix 基础组件；新增迁移方案需要独立技术决策。

主题及终端颜色统一维护在 `src/renderer/src/index.css`。`src/renderer/src/lib/utils.ts` 是组件工具别名的兼容入口，虽未被当前业务代码直接导入，仍由 CLI 配置引用，不按无引用业务文件清理。

## 自动化测试

提交代码前运行：

```sh
npm run check
npm test
npm run build
npm run test:desktop
npm run test:sidebar
npm run test:p0
npm run test:acceptance
npm run test:recovery
```

| 测试文件 | 主要覆盖 |
| --- | --- |
| `tests/assets.test.ts` | 资产字段、数量、层级、引用、搜索、重命名、移动 / 删除子树、展开规则与存储边界 |
| `tests/terminal-tabs.test.ts` | 标签增删、选择、上限、排序及会话身份保留 |
| `tests/terminal-session.test.ts` | 桌面会话管理下的协议拒绝、真实本地 Shell、尺寸、背压与关闭隔离 |
| `tests/desktop-dev.test.ts` | Vite 页面与前端入口、回环监听配置及禁止页面嵌入 |
| `tests/ssh-protocol.test.ts` | SSH 参数、认证内容与指纹响应校验 |
| `tests/credential-store.test.ts` | 加密记录恢复、端点绑定、损坏 / 锁定、输入边界及删除 |
| `tests/regex-search.test.ts` | 正则大小写、方向、循环查找、Unicode 偏移及无效 / 零宽匹配 |
| `tests/terminal-transport.test.ts` | 开发期重复挂载不预占多余名额、异步创建期间关闭的会话释放 |
| `tests/terminal-input.test.ts` | 分块边界的 Unicode 完整性、独立 UTF-8 编码及协议长度限制 |
| `tests/known-hosts.test.ts` | 独立存储实例并发确认、不同指纹竞争、损坏记录与后续写入恢复 |
| `tests/ssh-server.test.ts` | 首次信任、指纹变化、认证、流解码、背压与连接隔离 |
| `tests/desktop-security.test.ts` | 桌面来源、主框架、资源路径、会话归属、限额、ACK 和隔离清理 |
| `tests/settings.test.ts` | 设置边界、默认值、持久化 / 损坏隔离、保存失败及 Shell 不可用 |
| `tests/p0-interactions.test.ts` | 退出应答状态机、快捷键 / IME 守卫、URL 白名单、导入导出与重连标签 |

`test:desktop` 启动真实 Electron，检查窗口可见性、统一顶栏 / 拖动区域样式、鼠标输入触发最小化 / 最大化 / 还原 / 关闭、外部窗口状态变化同步、深浅主题、沙箱配置、preload、本地 PTY、命令输入、多标签、窗口尺寸、SSH 首次指纹确认、密码认证、跨分块 emoji 粘贴，以及本地目录选择 IPC、取消 / 保存失败、指定目录启动、再次打开 / 资产恢复及退出清理。目录选择测试仅在测试主进程替换系统弹窗返回值，仍经过正式 IPC / preload / utility process；原生选择器的人工操作需另验。开发页面模式可用 `node scripts/test-desktop.mjs --dev` 验证；包内 ASAR 可用 `node scripts/test-desktop.mjs release/NovaTerminal-win32-x64/resources/app.asar/out/electron/main.cjs` 验证。ASAR 检查复用开发 Electron，不替代独立 exe 的 `test:package`。

测试会在本机启动真实 Shell 和临时 SSH 协议服务，使用临时密钥及独立指纹目录，不依赖外部服务器或个人凭据。PTY / SSH 集成测试通过 `tests/helpers/session-client.ts` 驱动正式的桌面会话管理器和会话核心；`tests/fixtures/session-worker.ts` 仅为系统 Node.js 测试提供进程适配，不是另一种应用运行模式。真实 utility process 和 preload 由 Electron 冒烟覆盖。运行环境必须允许创建子进程及绑定回环端口；`spawn EPERM` 等权限错误需要结合执行环境判断。

`test:sidebar` 在独立临时配置中验证默认折叠、工具栏 / 分组菜单新增范围、SSH 编辑预填与端点认证校验、编辑刷新恢复、本地目录编辑和运行中标签名称同步、搜索恢复、资产真实鼠标拖拽、非法循环阻止、菜单边界、重命名、移动 / 删除对话框、存储失败和运行中会话标签移动。`test:desktop` 另验证真实 SSH 编辑后仍可免填重连、认证替换及安全存储 / 公开配置失败回滚。鼠标发起原生拖拽后，使用 Electron 调试协议接收拖拽数据并交付进入 / 悬停 / 放下事件；不读取个人资产。开发页面可用 `node scripts/test-desktop.mjs --sidebar --dev` 验证。

当前没有持续集成。自动化测试不能替代系统窗口交互、焦点、后台终端和真实服务器兼容性验证。桌面打包验收脚本当前面向 Windows x64；macOS / Linux 和真实远端 SSH 需单独验收。自绘最大化按钮不提供原生窗口按钮的悬停贴靠菜单，Windows 可使用系统快捷键贴靠窗口。冒烟截图保存在忽略提交的 `test-results/` 中。

`test:p0` 使用真实 Electron / PTY、Electron 键鼠输入和系统文本剪贴板，检查设置取消 / 保存、系统主题事件、720×480 布局、已有终端字号、动态上限、快捷键、搜索、复制、超限粘贴、多行取消、显式重连、导入回滚 / 导出及退出去重 / 取消。文件对话框返回值和外部浏览器调用使用测试替身；系统主题通过 Electron nativeTheme 模拟。可加 `--dev` 或指定 ASAR 入口重跑 `scripts/test-desktop.mjs --p0`。

`test:acceptance` 补充 Windows 专项交互：通过 Electron `sendInputEvent` 拖选并检查只在松开时复制；使用真实 PowerShell 长命令检查有选区 Ctrl+C 复制、清屏后无选区 Ctrl+C 中断；通过右键菜单粘贴中文 / emoji；检查搜索前后跳转、大小写、正则及表单快捷键隔离；点击实际渲染链接并验证鼠标报告模式下需 Ctrl 修饰键；检查 cmd 命令执行、PowerShell 7 不可用及失效目录不回退。链接点击测试替换 `shell.openExternal`，不默认启动浏览器。可加 `--dev` 或 ASAR 入口重跑 `scripts/test-desktop.mjs --acceptance`。测试读写并恢复系统文本剪贴板，不保证恢复图片等其他剪贴板格式。

显式设置 `NOVA_ACCEPT_BROWSER=1` 时，专项验收通过正式外链 IPC 启动系统默认浏览器，检查临时回环页面收到请求；测试结束关闭服务，浏览器标签需单独关闭。设置 `NOVA_ACCEPT_WSL=1` 时，记录默认 WSL 的启动与命令输出，记录仅供判读，不自动计为验收通过。测试结果写入 `test-results/p0-acceptance.json`。真实输入法候选确认、原生选择器、操作系统主题切换、外部编辑器粘贴、WSL / 可选 Shell 的环境兼容性及其他平台仍需专项验证；IME 守卫单元测试不能代替真实输入法测试。

`test:recovery` 使用独立用户数据目录和真实 Electron，检查同目录第二实例退出 / 原窗口恢复 / 重启配置保留；在 500 项人工 SSH 资产和系统加密记录中，分别于新记录写入后、公开配置提交后中断 renderer，检查重新加载回收余量且可继续编辑；损坏资产文档不清理密文。高回溯正则 `(a+)+$` 对 40 个 `a` 加 `!` 的真实 PTY 输出应超时，界面仍能执行心跳并继续普通正则搜索；通过复制选区检查软换行、中文、emoji 与组合字符映射，并恢复原文本剪贴板（不保留图片等格式）。故障注入和 DOM 合成事件仅位于测试桥接，不等同于物理键鼠或断电持久性测试。可用 `node scripts/test-recovery.mjs --dev` 验证开发页面。

性能验收需另覆盖最大回滚和 8 会话组合。单个高回溯表达式的超时回归不能作为全部大缓冲区容量与搜索性能通过的依据。系统主题模拟也不能代替启动视觉闪烁与真实系统主题操作的验收。

## 桌面交互测试

1. 执行 `npm run dev`，等待 Electron 窗口可见；确认开发页面来自本项目的 `127.0.0.1:5180`。使用 `npm start` 检查已构建的应用。
2. 检查顶栏按钮、深浅主题、最小化、最大化 / 还原、关闭及拖动。可在 Electron DevTools 检查界面和 IPC；普通浏览器没有 preload，不能提供终端功能。
3. 新建本地终端，等待“运行中”和 Shell 提示符，输入 `echo NOVA_UI_OK` 并按回车，检查独立输出行。随后检查标签增删 / 切换、主题、SSH 认证方式切换及资产表单。需要验证保存和搜索时使用明确的测试数据，并说明数据保留或清理方式。
4. 每次交互后检查最新页面状态；布局验证需截图确认。记录实际完成范围，区分表单显示、配置保存和真实连接。
5. 结束后关闭自己创建的终端、取消未提交表单，恢复临时主题设置；不要关闭他人的会话或停止原有开发服务。

构建预览使用 `npm run build` 后执行 `npm start`，验证与正式资源一致的桌面链路。

## 依赖安全检查

```sh
npm audit --omit=dev --registry=https://registry.npmjs.org
npm audit --registry=https://registry.npmjs.org
```

命令中的 registry 仅影响本次调用，适用于所用镜像未提供审计接口的情况。

审计结果随锁文件和漏洞数据库变化，发布前重新检查。单次结果放在忽略的 `docs/local/`，记录命令、日期与依赖范围；有告警时核对受影响链路、修复版本与兼容性，不直接采用跨主版本降级建议。

## 文档与许可

README 面向使用者，本文维护开发与验证方法，`docs/ai-context.md` 仅保留后续协作需要的状态和决策。`docs/plans/` 用于跨模块任务的范围、验收和进度，完成后将有效决策整合进长期文档，删除重复过程记录。

个人操作、本机环境排障、工具使用经历和单次审查 / 验收流水保留在 `docs/local/`；该目录由 `.gitignore` 排除。正式文档只保留通用方法、已确认的项目约束和可维护的决策。

依赖、组件、模板与字体的上游许可保存在 `THIRD_PARTY_NOTICES.txt` 和 `licenses/`。精简文档时保留原始版权与许可文本，不能将其视为重复说明删除。
