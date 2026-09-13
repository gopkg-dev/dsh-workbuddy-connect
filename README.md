# DSH WorkBuddy Connect · gopkg-dev fork

[English](./README.en.md) | 中文

将 WorkBuddy / WorkBuddy AI 桌面 App 中的模型接入 DeepSeek Harness，在 DSH 中复用已登录账号进行对话。

本仓库是 **[gopkg-dev 维护的 fork](https://github.com/gopkg-dev/dsh-workbuddy-connect)**，基于 [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) 的 `v0.5.0`（[`1830e03`](https://github.com/corrinehu/dsh-workbuddy-connect/commit/1830e03)）。npm 包名为 **`dsh-workbuddy-connect-gopkg`**，本 fork 从 **`0.6.0`** 开始独立发布。感谢原作者 Corrine Hu；保留原项目的 MIT 许可证与版权声明。

## 本 fork 增加了什么

- **按模型选择上下文窗口**：在「设置 → 插件 → WorkBuddy / WorkBuddy AI → 上下文」中，从模型目录的 `supportedContextWindows` 选择档位，例如 **300K / 1M**。未选择时使用 `contextWindow`；没有可选档位的模型继续使用该默认值。

- **保存并应用上下文选择**：选择后自动保存，国内版与国际版分别保存，重启后恢复。适配器将选定窗口用于后续模型调用；已保存的值无效或刷新后不再受支持时，回退到模型当前的 `contextWindow`。例如 `[300000, 1000000]` 可直接选 1M，无需手工修改模型目录缓存。

- **调整聊天与推理检测请求格式**：`src/upstream.ts` 中的聊天与推理档位检测请求采用 App 格式的 `User-Agent` 和 `X-IDE-Type`、`X-IDE-Name`、`X-IDE-Version`、`X-Private-Data` 请求头；通过现有解析器动态获取 App 版本，在客户端实例内缓存，解析失败时使用内置版本值。每次请求生成独立、不带连字符的 UUIDv4 作为 `X-Conversation-Request-ID`，JSON 请求体使用 gzip 压缩并发送 `Content-Encoding: gzip`。

可选上下文容量以模型目录声明为准，实际请求能否接受由服务端决定。请求格式的调整不保证改变服务端对客户端的识别、计费、额度或限制。完整记录见 [CHANGELOG](./CHANGELOG.md)。

## 继承自上游的功能

国内版 **WorkBuddy** 与国际版 **WorkBuddy AI** 同时支持：两个都安装并登录时，两组模型并存，各自使用自己的账号与积分。以下截图由上游提供，未展示本 fork 新增的上下文选择控件。

- **开箱即用**：安装和启用插件后，在 DSH 中直接使用，无需额外配置。


![WorkBuddy 模型出现在 DSH 模型选择器中](assets/1.png)


- **国内版与国际版并存**：国内版显示为「WorkBuddy」分组，国际版（WorkBuddy AI）显示为「WorkBuddy AI」分组。两版的模型、账号和积分互不混用。**各自只看自己那版 App 的登录状态**：只装国际版就只出现「WorkBuddy AI」，两版都装就两组都在，退出其中一版则对应分组消失。设置里也是**两张卡片**，分别展示各自的账号与余额。

![WorkBuddy AI 模型出现在 DSH 模型选择器中](assets/5.png)


- **图片输入**：大部分模型支持发图，在对话里直接粘贴或拖入图片即可（GLM-5.3-Flash、GLM-5.2、DeepSeek-V4 系列等）；少数只支持文字的模型（如 GLM-5.1）会明确提示不支持。


- **推理档位**：WorkBuddy 明确声明的档位会直接显示，例如 GLM-5.3 和 GLM-5.3-Flash 可选 low / high / max。对于部分没有声明可选档位的模型，Web 和 Desktop 可在模型选择器中点击「推理等级」手动检测；检测会发送少量请求，可能消耗积分。未检测或没有可用档位的模型仍使用 WorkBuddy 的默认档位。


- **信息查看与检测**：设置 → 插件 → 对应卡片可查看账号、令牌有效期、剩余积分和模型优惠；也可以手动刷新模型列表，并在卡片上看到当前列表来自上游还是内置兜底。对于可检测模型，也可以在这里手动检测推理档位。

- **费率比例**：模型选择列表里每个模型名后直接显示积分倍率（如 `GLM-5.2 · x0.79`、`Hy3 · x0.00`），`/model` 弹窗与输入框的模型下拉都能看到。倍率只是显示，不影响实际请求。


- **徽章展示**：促销徽章（限时免费、夜间折扣）直接跟在模型名后面（如 `Hy4 preview · x0.00 · 限时免费`），选模型时一眼可见；设置卡片里也会汇总当前有优惠的模型。以 WorkBuddy 服务端的数据为准，每次启动 DSH 时同步。国际版的促销来自服务端的 `modelPromotions`（含生效时段）：促销过期后徽章会撤销；由于服务端把折后价直接写在模型的倍率字段里，原价无法还原，此时该模型的倍率会显示为「价格未知 — 刷新后更新」，而不是继续显示折扣价或「免费」。

![设置卡片显示插件](assets/2.png)

![设置卡片显示账号与剩余积分](assets/3.png)

## 推理档位为什么这样设计

WorkBuddy 中模型的推理档位信息目前分散在上游接口与客户端自身的私有 UI 逻辑中，且模型目录变化很快。若插件根据经验为所有未声明模型补齐统一档位，就需要持续追赶这些未公开、没有稳定契约的产品逻辑。

![设置档位](assets/4.png)


实测还发现，有些模型虽然接受 `reasoning_effort` 参数，却可能忽略未知值并回退到默认行为；一次请求返回成功，并不能证明某个档位真实可用。

因此，对于没有声明档位的模型，Web 和 Desktop 采用用户主动授权触发、动态获取档位的方式：先确认上游会校验该参数，再逐项确认哪些规范档位被接受。检测会发送少量请求，可能消耗积分；结果只表示当前上游接受该档位，不承诺它一定改变推理效果、速度或积分消耗。

## 安装与迁移

前置：已安装并登录 WorkBuddy 或 WorkBuddy AI 桌面 App。插件复用 App 的登录状态；Node.js 需满足 `^22.19.0 || >=24.0.0`。

本 fork 沿用上游 `0.5.0` 的依赖要求：DSH 核心 `0.1.5-rc.1` 及以上，对应上游说明中的 Desktop `2.0.7`+；TUI 插件 `@deepseek-harness-tui/dsh-tui` 需 `0.10.0-beta.5` 及以上。旧 DSH 用户请参考[上游安装说明](https://github.com/corrinehu/dsh-workbuddy-connect#安装)选择上游旧版；本 npm 包没有上游 `0.3.1` 等历史版本。

**同一 profile 不要同时启用原版与本 fork**：两者共用 provider 和设置标识。从原版迁移时，先移除原包，再安装本 fork。

### Web

```sh
# 仅从原版迁移时执行
dsh plugin --profile web remove dsh-workbuddy-connect

# 安装本 fork（npm 包包含预构建产物）
dsh plugin --profile web add dsh-workbuddy-connect-gopkg
dsh web
```

也可以从本 fork 的 GitHub 源码安装：

```sh
dsh plugin --profile web add github:gopkg-dev/dsh-workbuddy-connect
```

### Desktop

在 DSH Desktop 内置插件市场中安装 **`dsh-workbuddy-connect-gopkg`**；已安装原版的用户先移除原版。Desktop profile 由桌面应用管理，DSH CLI 不接受 `--profile desktop` 的插件管理命令。

### TUI

```sh
# 仅从原版迁移时执行
dsh plugin --profile dsh-tui remove dsh-workbuddy-connect

dsh plugin --profile dsh-tui add dsh-workbuddy-connect-gopkg
dsh --profile dsh-tui
```

上游 TUI 安装说明要求 pnpm 11；若出现 `ERR_PNPM_UNEXPECTED_STORE`，请检查实际使用的 pnpm 版本。

安装后，在模型选择器中切换到 WorkBuddy / WorkBuddy AI。Web / Desktop 插件设置提供上下文选择和推理档位检测；TUI 不提供这两个交互入口，可在 `/settings` 配置 `authFile`（国际版为 `authFileAI`）。

## 命令行

安装和移除使用新 **npm 包名** `dsh-workbuddy-connect-gopkg`；包内 **可执行文件名**仍为 `dsh-workbuddy-connect`，因此 `exec` 后保留旧名称：

```sh
# 国内版状态
dsh plugin --profile web exec dsh-workbuddy-connect status

# 国际版状态与诊断
dsh plugin --profile web exec dsh-workbuddy-connect status --provider workbuddy-ai
dsh plugin --profile web exec dsh-workbuddy-connect doctor --provider workbuddy-ai
```

将 `web` 替换为 `dsh-tui` 即可操作 TUI profile。`status --json` 输出机器可读结果；`logout` 仅清理所选版本的插件凭据副本，不退出桌面 App，也不保证模型分组消失。

## 开发与发布

```sh
pnpm install
npm run check
npm pack --dry-run

# 已登录 npm，且拥有此包的发布权限时
npm publish --access public
```

`npm run check` 执行类型检查、测试和构建；打包前也会自动构建。发布前检查包名、版本和文件清单，发布后用安装章节的命令验证。npm 登录与发布条件参见 [npm publish 文档](https://docs.npmjs.com/cli/commands/npm-publish)。

本 fork 的验证覆盖上下文默认值、保存与恢复、国内/国际版隔离、失效档位回退，以及请求头和 gzip 编码；上下文设置交互还进行了隔离 UI 验证。这些验证不等同于对所有平台、模型或上游继承功能重新进行真实服务端测试。

## 已知限制

- 上游报告在 macOS 的 DSH Web / Desktop / TUI 下验证通过（上游 0.3.2 起要求 `0.1.5-rc.1`+、Node 22+；TUI 需终端界面插件 `0.10.0-beta.5` 及以上，见安装章节说明）。Windows 会依次探测 Local 与 Roaming AppData；WSL 会优先从挂载的 Windows 用户目录读取登录凭据。若 Windows 与 Linux 用户名不同且 Windows 环境变量未传入 WSL，请通过 `WORKBUDDY_AUTH_FILE`（国际版为 `WORKBUDDY_AI_AUTH_FILE`）指定实际位置。
- **国际版的模型目录来自 App 界面接口**：服务端按 User-Agent 分流下发，属私有实现，上游改动可能使其失效。届时插件按「本账号上次成功目录 → 内置目录」降级，并在卡片上标明来源（实时 / 已保存 / 内置）、更新时间与失败原因，但不能保证长期兼容。国内版目录走官方 CLI 同款接口，不受此影响。
- **国际版仍未覆盖的环境**：Windows / WSL / Linux 下国际版 App 的版本读取尚未找到可靠来源，会退回最近保存的版本或内置值。上游报告在 macOS 上通过真实 shim 验证了 GPT 系完整回复、工具调用与续轮。
- **无凭据时的行为变化**：某版 App 从未登录、也没留下插件自留副本时，该版模型分组不再显示。此前国内版会显示一份内置兜底列表，但那些模型选了必然报错。
- 依赖 WorkBuddy 客户端接口（非官方开放 API），WorkBuddy 更新后插件可能需要随之调整。

## 免责声明

- 本项目**仅供个人学习和研究使用**，仅驱动使用者自己的 WorkBuddy 账号在本机调用，请勿用于商业用途或超出个人合理使用的场景。
- 使用者需遵守 WorkBuddy 的服务条款；因使用本项目产生的任何后果（包括但不限于账号被限制、额度被清空、服务中断），由使用者自行承担。
- 本项目作者不对任何因使用或滥用本项目产生的直接或间接损失负责。
- 本项目与腾讯、WorkBuddy、DeepSeek 均无关联，未获其授权或认可；文中出现的名称仅用于描述兼容关系，其商标权利归各自所有。

## 致谢

- [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)（MIT）— 本 fork 的上游项目，原作者 Corrine Hu。
- [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api)（MIT）— WorkBuddy 上游协议的参照实现。
- [franksong2702/dsh-codex-connect](https://github.com/franksong2702/dsh-codex-connect)（Apache-2.0）— DSH 插件结构与 provider 注册的参照。

## 许可证

[MIT](./LICENSE)，保留原作者版权声明。
