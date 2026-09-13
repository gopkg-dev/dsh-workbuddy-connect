# DSH WorkBuddy Connect · gopkg-dev fork

English | [中文](./README.md)

Use models from the WorkBuddy / WorkBuddy AI desktop apps in DeepSeek Harness with your existing signed-in accounts.

This is the **[fork maintained by gopkg-dev](https://github.com/gopkg-dev/dsh-workbuddy-connect)**, based on [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) `v0.5.0` ([`1830e03`](https://github.com/corrinehu/dsh-workbuddy-connect/commit/1830e03)). Its npm package is **`dsh-workbuddy-connect-gopkg`**, with independent releases starting at **`0.6.0`**. Thanks to original author Corrine Hu; the original MIT license and copyright notice are retained.

## What this fork adds

- **Per-model context windows**: open Settings → Plugins → WorkBuddy / WorkBuddy AI → Context, and select a window from the catalog's `supportedContextWindows`, such as **300K / 1M**. Without a selection, `contextWindow` applies; models without selectable windows keep that default.

- **Persistent context preferences**: choices save automatically, are stored separately for CN and international providers, and survive restarts. The adapter uses the chosen window for subsequent model calls. Invalid saved values, or values no longer supported after a catalog refresh, fall back to the model's current `contextWindow`. For `[300000, 1000000]`, select 1M without editing the catalog cache.

- **Chat and reasoning-probe request formatting**: `src/upstream.ts` sends an app-format `User-Agent` and `X-IDE-Type`, `X-IDE-Name`, `X-IDE-Version`, and `X-Private-Data` headers. The existing resolver supplies the app version, cached per client instance, with a built-in fallback if resolution fails. Every request receives a fresh UUIDv4 without hyphens as its `X-Conversation-Request-ID`; JSON bodies are compressed with gzip and sent with `Content-Encoding: gzip`.

Context choices follow the catalog declaration; the service still decides whether to accept an actual request. Request formatting changes do not guarantee changes to server-side client recognition, pricing, quotas, or restrictions. See the [CHANGELOG](./CHANGELOG.md).

## Features inherited from upstream

Both CN **WorkBuddy** and international **WorkBuddy AI** are supported: installing and signing in to both provides two model groups, each with its own account and credit. The screenshots below were supplied by upstream and do not show this fork's new context selection controls.

- **Works out of the box**: install and enable the plugin, then use it directly in DSH — no extra configuration.

![WorkBuddy models in the DSH model picker](assets/1.png)

- **CN and international side by side**: the CN app appears as the **WorkBuddy** group and the international one as **WorkBuddy AI**. Their models, accounts, and credit never mix. **Each group follows only its own app's sign-in**: install just the international app and only WorkBuddy AI appears; install both and both groups appear; sign out of one and that group goes away. Settings likewise shows **one card per version**, each with its own account and balance.

![WorkBuddy AI models in the DSH model picker](assets/5.png)

- **Image input**: most models accept images — paste or drop one straight into the conversation (GLM-5.3-Flash, GLM-5.2, the DeepSeek-V4 series, and more); the few text-only models (e.g. GLM-5.1) clearly say so.

- **Reasoning levels**: levels explicitly declared by WorkBuddy appear directly — for example, GLM-5.3 and GLM-5.3-Flash offer low / high / max. For some models that do not declare selectable levels, Web and Desktop provide a **Reasoning levels** control in the model picker for a manual check. It sends a few requests and may consume credit. Models without a check result or selectable levels continue to use WorkBuddy's default.

- **Status and detection**: Settings → Plugins → the matching card shows the account, token validity, remaining credit, and model offers. It also lets you refresh the model list manually and shows whether the current list came from the upstream or from the built-in fallback, and provides manual reasoning-level detection for eligible models.

- **Rate**: every model name carries its credits multiplier (e.g. `GLM-5.2 · x0.79`, `Hy3 · x0.00`) in both the `/model` popup and the composer's model dropdown. The rate is display-only and never affects requests.

- **Promo badges**: promo badges (`限时免费`, `夜间折扣`) ride the model name itself (e.g. `Hy4 preview · x0.00 · 限时免费`), visible wherever you pick a model; the status card also collects currently-discounted models. Per the WorkBuddy service data, synced each time DSH starts. The international version's promotions come from the service's `modelPromotions` (which carry an effective window). Once a promotion lapses its badge is withdrawn; because the service writes the discounted value into the model's own rate field, the original price cannot be reconstructed, so that model then reports "price unavailable — refresh to update" rather than repeating the discounted rate or claiming the model is free.

![Settings card showing the plugin](assets/2.png)

![Settings card showing account and remaining credit](assets/3.png)

## Why reasoning levels work this way

Information about WorkBuddy models' reasoning levels is currently split between upstream API responses and private UI logic in the client, while the model catalog changes quickly. If the plugin filled in one uniform set of levels for every model without an upstream declaration, it would need to keep chasing unpublished product logic with no stable contract.

![Reasoning-level detection in the composer](assets/4.png)

Testing also found that some models accept the `reasoning_effort` parameter while ignoring unknown values and falling back to their default behavior. A successful request alone therefore does not prove that a level is actually usable.

For models without declared levels, Web and Desktop instead use user-authorized, on-demand detection: it first confirms that the upstream validates the parameter, then checks which standard levels it accepts. The check sends a few requests and may consume credit. Its result means only that the upstream currently accepts that level; it does not promise a particular change in reasoning quality, speed, or credit use.

## Install and migrate

Prerequisites: install and sign in to the WorkBuddy or WorkBuddy AI desktop app. The plugin reuses its sign-in state. Node.js must satisfy `^22.19.0 || >=24.0.0`.

This fork retains upstream `0.5.0`'s requirements: DSH core `0.1.5-rc.1` or newer, corresponding to Desktop `2.0.7`+ in the upstream instructions. The TUI package `@deepseek-harness-tui/dsh-tui` must be `0.10.0-beta.5` or newer. For older DSH versions, consult the [upstream installation instructions](https://github.com/corrinehu/dsh-workbuddy-connect/blob/main/README.en.md#install) and use an upstream release; this npm package does not provide historical upstream versions such as `0.3.1`.

**Do not enable the original plugin and this fork in the same profile**: they share provider and settings identifiers. Remove the original package before installing this fork.

### Web

```sh
# Only when migrating from the original plugin
dsh plugin --profile web remove dsh-workbuddy-connect

# Install this fork (the npm package includes built artifacts)
dsh plugin --profile web add dsh-workbuddy-connect-gopkg
dsh web
```

Alternatively, install from this fork's GitHub source:

```sh
dsh plugin --profile web add github:gopkg-dev/dsh-workbuddy-connect
```

### Desktop

Install **`dsh-workbuddy-connect-gopkg`** from DSH Desktop's built-in plugin market; remove the original plugin first if installed. The desktop app manages its own profile, and the DSH CLI rejects plugin management with `--profile desktop`.

### TUI

```sh
# Only when migrating from the original plugin
dsh plugin --profile dsh-tui remove dsh-workbuddy-connect

dsh plugin --profile dsh-tui add dsh-workbuddy-connect-gopkg
dsh --profile dsh-tui
```

Upstream TUI installation instructions require pnpm 11; check the active pnpm version if installation reports `ERR_PNPM_UNEXPECTED_STORE`.

After installation, select WorkBuddy / WorkBuddy AI in the model picker. Web / Desktop plugin settings provide context selection and reasoning-level probes. TUI does not expose those two interactive controls; configure `authFile` in `/settings` (`authFileAI` for the international app).

## CLI

Installation and removal use the new **npm package name**, `dsh-workbuddy-connect-gopkg`. The bundled **executable** remains `dsh-workbuddy-connect`, so keep that name after `exec`:

```sh
# CN account status
dsh plugin --profile web exec dsh-workbuddy-connect status

# International account status and diagnostics
dsh plugin --profile web exec dsh-workbuddy-connect status --provider workbuddy-ai
dsh plugin --profile web exec dsh-workbuddy-connect doctor --provider workbuddy-ai
```

Replace `web` with `dsh-tui` for the TUI profile. `status --json` produces machine-readable output. `logout` removes only the selected version's plugin-owned credential copy; it does not sign out of the desktop app or guarantee that its model group disappears.

## Development and publishing

```sh
pnpm install
npm run check
npm pack --dry-run

# When signed in to npm with permission to publish this package
npm publish --access public
```

`npm run check` runs type checks, tests, and the build; packing also triggers a build. Review the package name, version, and file list before publishing, then verify installation with the commands above. See the [npm publish documentation](https://docs.npmjs.com/cli/commands/npm-publish) for registry authentication and publication requirements.

Fork validation covers context defaults, persistence and restoration, CN/international separation, invalid-window fallback, request headers, and gzip encoding. Context settings also received isolated UI verification. This does not constitute fresh live-service testing of every platform, model, or inherited upstream feature.

## Known limitations

- Upstream reports verification on macOS with the DSH Web / Desktop / TUI profiles (as of upstream 0.3.2 this requires `0.1.5-rc.1`+ and Node 22+; TUI requires the terminal UI package `0.10.0-beta.5` or newer — see the Install section). Windows probes Local and Roaming AppData in order; WSL first reads credentials from the mounted Windows user profile. If the Windows and Linux user names differ and Windows environment variables are not forwarded into WSL, point `WORKBUDDY_AUTH_FILE` (or `WORKBUDDY_AI_AUTH_FILE` for the international version) at the actual file.
- **The international version's model catalog comes from the app's own interface**: the service splits it by User-Agent, which is a private implementation detail that a server-side change can break. When that happens the plugin degrades to this account's last successful catalog and then to its built-in roster, showing the source (live / saved / built-in), the fetch time, and the failure reason on the card — but long-term compatibility is not guaranteed. The CN version's catalog uses the same interface as the official CLI and is unaffected.
- **International-version environments not yet covered**: on Windows / WSL / Linux no reliable source for the international app's version has been located yet, so the saved value or the built-in default is used. Upstream reports that macOS real-shim checks covered complete GPT-family replies, tool calls, and continued turns.
- **Behaviour change with no credentials**: a version whose app was never signed in — and that left no plugin-owned copy — no longer shows a model group. The CN version used to display a built-in fallback list, but every model on it failed when selected.
- Relies on WorkBuddy client interfaces (not a public API); the plugin may need updates as WorkBuddy changes.

## Disclaimer

- This project is for **personal learning and research only**, driving your own WorkBuddy account on your own machine. Do not use it commercially or beyond reasonable personal use.
- Users must comply with the WorkBuddy terms of service. Any consequence of using this project (including but not limited to account restrictions, depleted credit, or service interruption) is borne by the user.
- The author is not liable for any direct or indirect loss arising from the use or misuse of this project.
- This project is not affiliated with, endorsed by, or sponsored by Tencent, WorkBuddy, or DeepSeek. Product names are used for compatibility description only; trademarks belong to their respective owners.

## Acknowledgements

- [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) (MIT) — the upstream project, by original author Corrine Hu.
- [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api) (MIT) — reference implementation of the WorkBuddy upstream protocol.
- [franksong2702/dsh-codex-connect](https://github.com/franksong2702/dsh-codex-connect) (Apache-2.0) — reference for the DSH plugin structure and provider registration.

## License

[MIT](./LICENSE), retaining the original author's copyright notice.
