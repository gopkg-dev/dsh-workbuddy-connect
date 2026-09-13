import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SettingsProvider from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import * as WorkBuddy from '../src/index.ts'

class MemorySettings extends SettingsProvider {
  readonly writable = true
  private storedDocument: Record<string, unknown> = {}

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.storedDocument))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.storedDocument[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

let context: Context | undefined
let root: string | undefined
let server: Server | undefined

/** Capture the real plugin route wiring while keeping the host fixture small. */
class TestWebServer extends Service {
  static routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>()

  constructor(ctx: Context) {
    super(ctx, 'webServer')
    TestWebServer.routes = new Map()
  }

  register(route: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }): () => void {
    TestWebServer.routes.set(route.path, route.handler)
    return () => { TestWebServer.routes.delete(route.path) }
  }
}

/** A desktop-shaped credential document for one upstream region. */
function credentialDocument(domain: string): string {
  return JSON.stringify({
    auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, domain },
    account: { uid: 'uid-1', nickname: 'nick', enterpriseId: 'ent-1' },
  })
}

afterEach(async () => {
  if (server !== undefined) await new Promise<void>(resolve => server?.close(() => resolve()))
  server = undefined
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('WorkBuddy Host settings integration', () => {
  it('persists context selections per variant, merges concurrent writes, and restores them after restart', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-context-settings-'))
    vi.stubEnv('DSH_HOME', root)
    const nativeFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline in tests') }))
    const snapshots = new Map<string, string>()
    for (const variant of WorkBuddy.WORKBUDDY_VARIANTS) {
      const auth = join(root, `${variant.id}.info`)
      await writeFile(auth, credentialDocument(variant.id === 'workbuddy' ? 'copilot.tencent.com' : 'www.workbuddy.ai'))
      vi.stubEnv(variant.id === 'workbuddy' ? 'WORKBUDDY_AUTH_FILE' : 'WORKBUDDY_AI_AUTH_FILE', auth)
      const catalogPath = join(root, variant.catalogFilename)
      new WorkBuddy.WorkBuddyCatalogStore(catalogPath).set('uid-1:ent-1', {
        source: 'test', fetchedAtMs: Date.now(),
        models: ['shared-model', 'other-model'].map(id => ({
          id, name: id, contextWindow: 300_000, maxInputTokens: 1_000_000, maxTokens: 64_000, supportsImages: false,
          supportedContextWindows: [300_000, variant.id === 'workbuddy' ? 600_000 : 1_000_000],
        })),
      })
      snapshots.set(catalogPath, await readFile(catalogPath, 'utf8'))
    }
    const persisted: Record<string, Record<string, unknown>> = {}
    class PersistentSettings extends SettingsProvider {
      readonly writable = true
      protected load(): Promise<Record<string, unknown>> { return Promise.resolve(structuredClone(persisted)) }
      protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
        persisted[ns] = structuredClone(section)
        return Promise.resolve()
      }
    }
    const boot = async (): Promise<Context> => {
      const ctx = new Context()
      context = ctx
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(PersistentSettings)
      await ctx.plugin(TestWebServer)
      await ctx.plugin(WorkBuddy, {})
      await vi.waitFor(async () => {
        expect((await ctx.llm.listModels('workbuddy-ai')).map(model => model.id)).toContain('shared-model')
        expect((await ctx.llm.listModels('workbuddy')).map(model => model.id)).toContain('shared-model')
      })
      return ctx
    }
    let ctx = await boot()
    server = createServer((req, res) => {
      const handler = TestWebServer.routes.get(new URL(req.url ?? '/', 'http://127.0.0.1').pathname)
      if (handler === undefined) { res.writeHead(404).end(); return }
      void handler(req, res)
    })
    await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const status = await (await nativeFetch(`${origin}${WorkBuddy.AI_VARIANT.statusPath}`)).json() as { probeKey: string }
    const select = async (variant: WorkBuddy.WorkBuddyVariant, model: string, contextWindow: number): Promise<void> => {
      const response = await nativeFetch(`${origin}${variant.probePath}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WorkBuddy-Probe-Key': status.probeKey },
        body: JSON.stringify({ action: 'context-window', model, contextWindow }),
      })
      expect(response.status).toBe(200)
    }
    await Promise.all([
      select(WorkBuddy.AI_VARIANT, 'shared-model', 1_000_000),
      select(WorkBuddy.AI_VARIANT, 'other-model', 1_000_000),
      select(WorkBuddy.CN_VARIANT, 'shared-model', 600_000),
    ])
    expect(persisted['workbuddy-ai']).toEqual({ modelContextWindowsAI: { 'shared-model': 1_000_000, 'other-model': 1_000_000 } })
    expect(persisted['workbuddy']).toEqual({ modelContextWindows: { 'shared-model': 600_000 } })
    expect((await ctx.llm.resolveModelInfo('workbuddy-ai', 'shared-model')).context?.contextWindow).toBe(1_000_000)
    expect((await ctx.llm.resolveModelInfo('workbuddy', 'shared-model')).context?.contextWindow).toBe(600_000)
    const updatedStatus = await (await nativeFetch(`${origin}${WorkBuddy.AI_VARIANT.statusPath}`)).json() as { models: Record<string, unknown>[] }
    expect(updatedStatus.models.find(model => model['id'] === 'shared-model')).toMatchObject({ contextWindow: 1_000_000, defaultContextWindow: 300_000 })

    // Direct settings edits also invalidate snapshots; stale positive values
    // may remain saved, but cannot override the current catalog's choices.
    await ctx.settings.update('workbuddy-ai', { modelContextWindowsAI: { 'shared-model': 500_000 } })
    await vi.waitFor(async () => {
      expect((await ctx.llm.resolveModelInfo('workbuddy-ai', 'shared-model')).context?.contextWindow).toBe(300_000)
    })
    await select(WorkBuddy.AI_VARIANT, 'shared-model', 1_000_000)
    await expect(ctx.settings.update('workbuddy-ai', { modelContextWindowsAI: { 'shared-model': 0 } })).rejects.toThrow()
    await ctx.fiber.dispose()
    ctx = await boot()
    expect((await ctx.llm.resolveModelInfo('workbuddy-ai', 'shared-model')).context?.contextWindow).toBe(1_000_000)
    expect((await ctx.llm.resolveModelInfo('workbuddy', 'shared-model')).context?.contextWindow).toBe(600_000)
    for (const [path, snapshot] of snapshots) expect(await readFile(path, 'utf8')).toBe(snapshot)
  })

  it('exposes the provider directory entry, the settings section, and the fallback model list', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-connect-settings-'))
    vi.stubEnv('DSH_HOME', root)
    const cnFile = join(root, 'cn.info')
    await writeFile(cnFile, credentialDocument('copilot.tencent.com'))
    vi.stubEnv('WORKBUDDY_AUTH_FILE', cnFile)
    vi.stubEnv('WORKBUDDY_AI_AUTH_FILE', join(root, 'absent-ai.info'))
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline in tests') }))
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(WorkBuddy, {})

    // Registration rides on the loopback shim's listening event.
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy')
    })
    expect(ctx.llm.listConfigurableProviders()).toContainEqual({
      provider: 'workbuddy',
      displayName: 'WorkBuddy',
      settingsNs: 'workbuddy',
      settingsPath: [],
      declared: false,
    })

    // The section is what the Models settings page joins on to render a card.
    const descriptor = ctx.settings.describe().find(entry => entry.ns === WorkBuddy.WORKBUDDY_SETTINGS_NS)
    expect(descriptor).toBeDefined()

    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy')).map(model => model.id)).toContain('auto')
    })
    const models = await ctx.llm.listModels('workbuddy')
    expect(models.map(model => model.id)).toContain('auto')
    expect(models.map(model => model.id)).toContain('deepseek-v4-pro')
    // The fallback catalog tracks the live `cli` roster, including the newer
    // models the desktop app offers that older builds lacked.
    expect(models.map(model => model.id)).toContain('hy4-preview')
    expect(models.map(model => model.id)).toContain('glm-5.3')

    // The billing rate rides the display name (and the advisory description)
    // so both the /model popup and the composer seat show it; the id and the
    // request path are untouched by this display-only decoration.
    const byId = new Map(models.map(model => [model.id, model]))
    // Since DSH 0.1.2 the composer seat renders the model name only, so both
    // the billing rate and the declared promo badges ride the name itself;
    // description stays untouched everywhere.
    expect(byId.get('glm-5.2')?.name).toBe('GLM-5.2 · x0.79 · 夜间折扣')
    expect(byId.get('glm-5.1')?.name).toBe('GLM-5.1 · x0.79')
    expect(byId.get('auto')?.name).toBe('Auto')
    expect(byId.get('glm-5.2')?.description).toBeUndefined()
    expect(byId.get('glm-5.3')?.description).toBeUndefined()

    // Thinking controls are declared-set-only: models whose upstream row
    // carries `supportedEfforts` expose exactly those efforts; rows without a
    // list (the older `{effort, summary}` shape) expose no control at all, so
    // requests never carry `reasoning_effort` for them and the upstream
    // default applies — matching the desktop app's own per-model gating.
    const autoResolved = await ctx.llm.resolveModelInfo('workbuddy', 'auto')
    expect(autoResolved.reasoning).toBeUndefined()
    const flashResolved = await ctx.llm.resolveModelInfo('workbuddy', 'glm-5.3-flash')
    expect(flashResolved.reasoning?.efforts.map(effort => effort.id).sort()).toEqual(['high', 'low', 'max', 'off'])

    // Image modalities follow the per-model catalog flag (fallback list here):
    // image-capable entries expose `image`, glm-5.1 stays text-only.
    const modalities = new Map(models.map(model => [model.id, model.inputModalities]))
    expect(modalities.get('auto')).toContain('image')
    expect(modalities.get('glm-5.1')).toEqual(['text'])

    // A settings write validates against the schema and persists.
    await ctx.settings.update(WorkBuddy.WORKBUDDY_SETTINGS_NS, { authFile: '/tmp/other-workbuddy.info' })
    const updated = ctx.settings.describe().find(entry => entry.ns === WorkBuddy.WORKBUDDY_SETTINGS_NS)
    expect((updated?.value as Record<string, unknown>)['authFile']).toBe('/tmp/other-workbuddy.info')
  })

  /**
   * Both providers register from one plugin, unconditionally, and the four
   * credential combinations are expressed through catalog visibility rather
   * than through registration. That is what lets a sign-in that happens while
   * DSH is already running surface without a restart.
   */
  it('registers both variants and keeps each variant identity separate', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-connect-dual-'))
    vi.stubEnv('DSH_HOME', root)
    // Shorten the credential sweep: the assertions below change a setting and
    // then wait for the group to react, which only happens on a sweep.
    vi.stubEnv('DSH_WORKBUDDY_POLL_MS', '100')
    // One real-shaped credential per product, in separate files. The upstream
    // fetch is stubbed to fail so the assertion covers the per-variant fallback
    // rosters rather than depending on the network.
    const cnFile = join(root, 'cn.info')
    const aiFile = join(root, 'ai.info')
    await writeFile(cnFile, credentialDocument('copilot.tencent.com'))
    await writeFile(aiFile, credentialDocument('www.workbuddy.ai'))
    vi.stubEnv('WORKBUDDY_AUTH_FILE', cnFile)
    vi.stubEnv('WORKBUDDY_AI_AUTH_FILE', aiFile)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline in tests') }))

    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(WorkBuddy, {})

    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(
        expect.arrayContaining(['workbuddy', 'workbuddy-ai']),
      )
    })

    // Each provider carries its own display name, which is the model group
    // heading the picker renders — and its OWN settings namespace: the Models
    // page resolves `settingsNs` against served sections, so a shared ns would
    // render both providers onto one card.
    expect(ctx.llm.listConfigurableProviders()).toEqual(expect.arrayContaining([
      { provider: 'workbuddy', displayName: 'WorkBuddy', settingsNs: 'workbuddy', settingsPath: [], declared: false },
      { provider: 'workbuddy-ai', displayName: 'WorkBuddy AI', settingsNs: 'workbuddy-ai', settingsPath: [], declared: false },
    ]))

    // THE DISPATCH CONTRACT. The Plugins tab renders a card by
    // `renderSlot('settings.plugin.item', {}, { entryKey: ns })` for each
    // namespace the Host serves, and skips an entry whose key names no served
    // namespace — the tab builds its list from sections, never from the slot's
    // registrations. A card whose variant id is not a served ns therefore
    // registers but never renders, which is exactly the bug this pins: every
    // variant id must be an installed section's namespace.
    const served = new Set(ctx.settings.describe().map(entry => entry.ns))
    for (const variant of WorkBuddy.WORKBUDDY_VARIANTS) {
      expect(served, `card key "${variant.id}" must be a served settings namespace`).toContain(variant.id)
    }
    expect(served).toContain(WorkBuddy.WORKBUDDY_AI_SETTINGS_NS)

    // Each section owns only its own fields, so one card's form cannot edit the
    // other's path. `describe()` reports the schema as schemastery's ref graph;
    // the root object's `dict` is the field map.
    const fieldsOf = (ns: string): string[] => {
      const descriptor = ctx.settings.describe().find(entry => entry.ns === ns)
      const root = (descriptor?.schema as { refs?: Record<string, { dict?: Record<string, unknown> }>, uid?: string } | undefined)?.refs?.[String((descriptor?.schema as { uid?: number } | undefined)?.uid)]
      return Object.keys(root?.dict ?? {})
    }
    expect(fieldsOf('workbuddy')).toContain('authFile')
    expect(fieldsOf('workbuddy')).not.toContain('authFileAI')
    expect(fieldsOf('workbuddy')).toContain('modelContextWindows')
    expect(fieldsOf('workbuddy')).not.toContain('modelContextWindowsAI')
    expect(fieldsOf('workbuddy-ai')).toEqual(['authFileAI', 'modelContextWindowsAI'])

    // A write through one section must reach ONLY that variant's store. The
    // schema assertions above prove the two forms are split; this proves the
    // wiring behind them is too. Without it, a section could carry the right
    // field while `onChange` handed it to the wrong store and nothing above
    // would notice.
    //
    // Observable chosen deliberately: point `authFileAI` at a file holding a
    // CN-domain credential. If the write really reached the AI store, that
    // store refuses the cross-product credential and the AI group empties; the
    // CN group must be untouched. A mis-routed write would instead empty the
    // CN group — so the assertion distinguishes "reached the AI store" from
    // "reached some store".
    const wrongRegionForAi = join(root, 'cn-credential-for-ai.info')
    await writeFile(wrongRegionForAi, credentialDocument('copilot.tencent.com'))
    await ctx.settings.update('workbuddy-ai', { authFileAI: wrongRegionForAi })
    // A bounded settle rather than waitFor: if the wiring were broken the group
    // would simply never change, and an assertion states that plainly instead
    // of surfacing as a timeout. Two sweeps at the 100 ms interval above.
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(await ctx.llm.listModels('workbuddy-ai')).toEqual([])
    expect((await ctx.llm.listModels('workbuddy')).length).toBeGreaterThan(0)

    // And the setting is genuinely read back through the merged config: putting
    // a valid international file back restores the group.
    await ctx.settings.update('workbuddy-ai', { authFileAI: aiFile })
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy-ai')).length).toBeGreaterThan(0)
    }, { timeout: 10_000 })

    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels('workbuddy')).length).toBeGreaterThan(0)
      expect((await ctx.llm.listModels('workbuddy-ai')).length).toBeGreaterThan(0)
    })

    // The two variants must not share a roster: the international models are
    // not reachable through the CN provider, and vice versa. A shared fallback
    // list would misdescribe one of them (different rates, windows, and
    // declared efforts).
    const cn = (await ctx.llm.listModels('workbuddy')).map(model => model.id)
    const ai = (await ctx.llm.listModels('workbuddy-ai')).map(model => model.id)
    expect(cn).toContain('minimax-m3')
    expect(ai).not.toContain('minimax-m3')
    expect(ai).toContain('gpt-5.6-luna')
    expect(cn).not.toContain('gpt-5.6-luna')
  })

  /**
   * With no credential present, a variant exposes nothing. This is the
   * deliberate behaviour change the plan calls out: the CN provider used to
   * publish 15 fallback models to a signed-out user, which offered models that
   * could only fail on the first message.
   */
  it('hides a variant with no usable credential while still registering it', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-connect-empty-'))
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('WORKBUDDY_AUTH_FILE', join(root, 'absent-cn.info'))
    vi.stubEnv('WORKBUDDY_AI_AUTH_FILE', join(root, 'absent-ai.info'))
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(WorkBuddy, {})

    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy')
    })
    await vi.waitFor(async () => {
      expect(await ctx.llm.listModels('workbuddy')).toEqual([])
    })
    expect(await ctx.llm.listModels('workbuddy-ai')).toEqual([])

    // The provider directory entry survives: the group is hidden by having no
    // models, not by unregistering, so a later sign-in needs no restart.
    expect(ctx.llm.listConfigurableProviders().map(entry => entry.provider))
      .toEqual(expect.arrayContaining(['workbuddy', 'workbuddy-ai']))
    // And the settings card is still there to explain how to sign in.
    expect(ctx.settings.describe().find(entry => entry.ns === WorkBuddy.WORKBUDDY_SETTINGS_NS)).toBeDefined()
  })

  /**
   * A credential for the other product is refused, and the refusal is what the
   * card shows. Silently treating it as "signed out" would send the user to
   * re-authenticate when the actual fix is a file path.
   */
  it('refuses a cross-product credential instead of using it', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-connect-cross-'))
    vi.stubEnv('DSH_HOME', root)
    // The CN file is handed to the international provider, which is exactly the
    // misconfiguration a user can produce with authFileAI / the env var.
    const crossFile = join(root, 'wrong.info')
    await writeFile(crossFile, credentialDocument('copilot.tencent.com'))
    vi.stubEnv('WORKBUDDY_AUTH_FILE', join(root, 'absent-cn.info'))
    vi.stubEnv('WORKBUDDY_AI_AUTH_FILE', crossFile)
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(WorkBuddy, {})

    const models = await (async () => {
      await vi.waitFor(() => {
        expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy-ai')
      })
      return ctx.llm.listModels('workbuddy-ai')
    })()
    // Refused, so the group stays hidden rather than serving a roster the token
    // cannot actually reach.
    expect(models).toEqual([])
  })
})
