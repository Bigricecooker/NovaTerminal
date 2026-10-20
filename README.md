# NovaTerminal

本地运行的 SSH 与终端客户端，采用 React、TypeScript 和 shadcn/ui 构建。

项目处于开发阶段，提供 Electron 桌面应用。Windows 支持构建可运行目录包；macOS 和 Linux 尚未验证。当前没有安装器、代码签名或自动更新。

## 功能

- **独立终端**：本地 Shell 与 SSH 共用多标签工作区，最多 4 个标签；切换保留会话和输出，关闭释放所属连接。
- **SSH 直连**：支持密码、私钥及加密私钥认证；首次连接需确认 SHA-256 主机指纹，已记录的指纹变化时拒绝连接。
- **连接管理**：创建连接与嵌套分组，按名称、主机、端口或用户名搜索；连接参数保存在当前应用的站点存储中，不含认证凭据。
- **终端显示**：支持 Unicode、ANSI、键盘输入、粘贴、尺寸同步及深浅主题。

当前不支持跳板机、SSH Agent、交互式多因素认证、凭据保存、文件传输或远端监控。连接配置暂不支持编辑、删除、导入或导出。

## 快速开始

环境要求：Node.js `>=24.19.0 <25`、npm `>=11.19.1 <12`。

```sh
npm ci
npm run dev
```

命令会启动桌面窗口，开发页面使用 `127.0.0.1:5180`。首次启动需要下载 Electron 运行时。修改主进程或 preload 后需重启开发命令，前端支持热更新。

桌面终端具有当前系统用户的 Shell 权限，通过受限 IPC 访问独立会话进程。Vite 仅用于桌面内的开发热更新，不提供独立浏览器终端服务；正式应用不监听 HTTP / WebSocket。完整边界见 [安全说明](SECURITY.md)。

### 本地终端

点击右上角“新建本地终端”。Windows 启动不加载用户 profile 的 PowerShell；macOS / Linux 使用环境变量 `SHELL` 指定的 Shell，未设置时使用 `/bin/sh`。初始工作目录为用户主目录。

关闭标签会移除对应输出；Shell 自行退出后保留标签供查看。刷新页面、退出应用或停止开发服务会断开会话，终端输出不持久化。主题选择仅在当前页面有效。

### SSH 连接

1. 点击“连接 SSH 服务器”，填写主机、端口和用户名。主机只填写域名或 IP，不包含 `ssh://`、用户名或路径。
2. 选择密码认证，或粘贴完整私钥及可选口令。认证信息仅用于当前连接，每次新建连接需重新填写。
3. 首次连接时，通过可信渠道向服务器管理员核对 SHA-256 指纹，再选择“信任并连接”。
4. 连接成功后在对应标签操作，连接状态与 Shell 信息显示在底部状态栏。

指纹变化或记录无法安全读写时连接会被阻止。记录位置与主机密钥变更处理见 [SSH 主机信任](SECURITY.md#ssh-主机信任)。SSH 断开后远端进程是否退出，取决于服务器配置及进程行为。

### 连接与分组

左侧“添加连接”和“添加分组”用于保存配置，创建不会自动连接。点击已保存连接后填写认证信息；搜索分组时包含其后代，搜索连接时保留所属分组。

最多保存 500 项资产、8 层分组。配置保存在应用站点的 `localStorage`，不包含密码、私钥或口令。桌面正式资源和桌面开发页面的配置互不共享；清理对应站点存储会移除配置，当前没有导出功能。

## 开发与验证

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 启动 Electron 桌面窗口和前端开发服务 |
| `npm run check` | 执行 TypeScript 和 ESLint 检查 |
| `npm test` | 执行模型、协议和会话集成测试 |
| `npm run build` | 类型检查并构建前端和 Electron 入口 |
| `npm start` | 启动已构建的桌面应用 |
| `npm run package` | 构建当前平台的可运行目录包，输出到 `release/` |
| `npm run test:desktop` | 执行真实 Electron、PTY 和临时 SSH 冒烟测试 |
| `npm run test:package` | 在独立临时目录验证 Windows exe、PTY、主题与退出清理 |

在 Windows x64 上，运行 `npm run package` 后打开 `release/NovaTerminal-win32-x64/NovaTerminal.exe`。请保留整个目录，不能只复制可执行文件；此目录包内置 Electron / Node.js，运行时无需系统 Node.js 或 Vite。

`dist/` 仅包含桌面前端，需通过 Electron 与 preload 启动；静态托管不能提供终端功能。源码开发需要完整仓库及 Node.js 依赖。`node-pty` 含原生模块，安装与测试要求见 [开发指南](docs/development.md)。

## 项目结构

```text
src/
  main/               Electron 主进程、安全校验与会话进程入口
  preload/            受限 preload 桥接
  renderer/           页面入口及 React 界面源码
  server/             会话进程核心、PTY、SSH 与主机指纹
  shared/             跨进程协议、参数校验和资源限额
scripts/              桌面开发、构建、打包与冒烟验证
tests/                Node.js 自动化测试
docs/                 开发指南与项目维护上下文
licenses/             第三方许可原文
.agents/skills/       项目协作技能
vite.config.ts        桌面前端构建与热更新配置
components.json       shadcn/ui 组件配置
package-lock.json     npm 依赖锁文件
```

桌面前端通过 preload 与主进程通信，每个会话运行在独立 utility process 中。本地终端使用 `node-pty`，远端通过 `ssh2` 直连。窗口按钮与应用操作按钮共用 React 顶栏及主题，窗口操作经有限 IPC 调用。数据流、资源限制和测试方法见 [开发指南](docs/development.md)。

## 参与贡献

提交问题或变更前，请阅读 [贡献指南](CONTRIBUTING.md)。提交信息使用 Conventional Commits；安全问题按 [安全说明](SECURITY.md) 报告。使用 AI 辅助开发时，遵循 [协作入口](AGENTS.md)。

## 许可

项目原创内容采用 [MIT License](LICENSE)。第三方代码、组件和字体保留各自许可，见 [第三方声明](THIRD_PARTY_NOTICES.txt) 和 [许可目录](licenses/)。
