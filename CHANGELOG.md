# 更新记录 / Changelog

本 fork 由 [gopkg-dev](https://github.com/gopkg-dev/dsh-workbuddy-connect) 维护，npm 包为 `@gopkg-dev/dsh-workbuddy-connect`。上游为 [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)，本 fork 基于上游 `v0.5.0`（`1830e03`）；保留 MIT 许可证与原作者版权声明。

## 0.6.0

### 新增 / Added

- Web / Desktop 插件设置新增按模型选择上下文窗口：从 `supportedContextWindows` 读取档位，例如 300K / 1M；未选择或没有可选档位时使用 `contextWindow`。
- 上下文选择自动保存，国内版与国际版分别保存，重启后恢复；非法或已失效的选择回退到目录默认值，选定窗口用于后续模型调用。
- Added per-model context selection in Web / Desktop settings, using catalog-declared windows, persistent preferences separated by provider, and fallback to the current catalog default.

### 调整 / Changed

- 聊天和推理档位检测请求使用 App 格式的 User-Agent 和 IDE 请求头；动态解析 App 版本，在客户端实例内缓存，并提供失败兜底。
- 每次请求使用独立的不带连字符的 UUIDv4 作为 `X-Conversation-Request-ID`；JSON 请求体使用 gzip 编码。
- Chat and reasoning probes now send app-format headers, a dynamically resolved and cached app version with fallback, a fresh dashless UUIDv4 request ID, and gzip-encoded JSON bodies. These changes do not guarantee any server-side recognition or billing outcome.
- npm 包名从首次发布使用的 `dsh-workbuddy-connect-gopkg` 调整为 `@gopkg-dev/dsh-workbuddy-connect`；新包名的首次发布保持 `0.6.0`。同步更新安装和迁移说明，GitHub 仓库不变，包内 CLI 可执行文件名保留为 `dsh-workbuddy-connect`。
- Renamed the npm package from `dsh-workbuddy-connect-gopkg` to `@gopkg-dev/dsh-workbuddy-connect`, with `0.6.0` as the first release under the scoped name. Installation and migration instructions follow the new name; the GitHub repository and bundled `dsh-workbuddy-connect` executable are unchanged.

### 迁移 / Migration

先在对应 DSH profile 中移除已安装的原版 `dsh-workbuddy-connect` 或本 fork 旧包 `dsh-workbuddy-connect-gopkg`，再安装 `@gopkg-dev/dsh-workbuddy-connect`。这些包共用 provider、设置标识和 CLI 可执行文件名，同一 profile 只启用一个版本。具体命令见 [README](./README.md#安装与迁移)。

Remove the installed original `dsh-workbuddy-connect` or former fork package `dsh-workbuddy-connect-gopkg` from the relevant DSH profile before installing `@gopkg-dev/dsh-workbuddy-connect`. Enable only one version per profile: they share provider identifiers, settings identifiers, and the CLI executable name. See the [installation and migration commands](./README.en.md#install-and-migrate).
