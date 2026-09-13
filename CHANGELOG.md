# 更新记录 / Changelog

本 fork 由 [gopkg-dev](https://github.com/gopkg-dev/dsh-workbuddy-connect) 维护，npm 包为 `dsh-workbuddy-connect-gopkg`。上游为 [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)，本 fork 基于上游 `v0.5.0`（`1830e03`）；保留 MIT 许可证与原作者版权声明。

## 0.6.0

### 新增 / Added

- Web / Desktop 插件设置新增按模型选择上下文窗口：从 `supportedContextWindows` 读取档位，例如 300K / 1M；未选择或没有可选档位时使用 `contextWindow`。
- 上下文选择自动保存，国内版与国际版分别保存，重启后恢复；非法或已失效的选择回退到目录默认值，选定窗口用于后续模型调用。
- Added per-model context selection in Web / Desktop settings, using catalog-declared windows, persistent preferences separated by provider, and fallback to the current catalog default.

### 调整 / Changed

- 聊天和推理档位检测请求使用 App 格式的 User-Agent 和 IDE 请求头；动态解析 App 版本，在客户端实例内缓存，并提供失败兜底。
- 每次请求使用独立的不带连字符的 UUIDv4 作为 `X-Conversation-Request-ID`；JSON 请求体使用 gzip 编码。
- Chat and reasoning probes now send app-format headers, a dynamically resolved and cached app version with fallback, a fresh dashless UUIDv4 request ID, and gzip-encoded JSON bodies. These changes do not guarantee any server-side recognition or billing outcome.
- 使用独立 npm 包名 `dsh-workbuddy-connect-gopkg`，更新 fork 仓库、安装、迁移和发布说明。包内 CLI 可执行文件名保留为 `dsh-workbuddy-connect`。
- Separate npm identity and fork-specific installation and migration documentation. The bundled executable remains `dsh-workbuddy-connect` for compatibility.

### 迁移 / Migration

先在对应 DSH profile 中移除原版，再安装本 fork；不要同时启用两者，因为 provider 与设置标识相同。Remove the original plugin before installing this fork in the same profile: both use the same provider and settings identifiers.
