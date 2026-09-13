import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkBuddyCredential } from '../src/auth.ts'
import { normalizeCredits, WorkBuddyUpstreamClient } from '../src/upstream.ts'

/**
 * Offline unit tests for WorkBuddyUpstreamClient, mocking the global `fetch`
 * so the multi-layer response parsing and the credit-remain selection logic in
 * `fetchCredits` are covered without a real account or network. This closes a
 * gap that previously relied solely on `scripts/live-e2e.mjs`.
 */

const CREDENTIAL: WorkBuddyCredential = {
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAtMs: 0,
  domain: 'www.codebuddy.cn',
  uid: 'uid-1',
  source: 'desktop',
}

/** Build the nested upstream billing document that `fetchCredits` unwraps. */
function billingEnvelope(accounts: unknown[]): string {
  return JSON.stringify({
    code: 0,
    msg: 'ok',
    data: {
      Response: {
        Data: {
          Accounts: accounts,
        },
      },
    },
  })
}

/** Minimal Response-like object satisfying `readEnvelope` (which calls `.text()`). */
function fakeResponse(body: string, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: () => Promise.resolve(body),
  } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * Desktop-App identity on chat requests.
 *
 * The gateway recognises a client by these headers; without them it does not
 * classify the caller as the App and answers with a gateway-generated `crb-…`
 * request id instead of echoing the caller's own. The expected values below are
 * taken from the real client's captured packet, so a regression here shows up
 * as a concrete header mismatch rather than a vague shape assertion.
 */
describe('chat request identity headers', () => {
  /** Run one chatStream against a stub fetch, returning the captured init. */
  async function captureChatInit(bodyJson: string): Promise<RequestInit> {
    let init: RequestInit | undefined
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, options?: RequestInit) => {
      init = options
      return fakeResponse('data: {}\n\n')
    }))
    const client = new WorkBuddyUpstreamClient({
      resolveAppVersion: async () => ({ version: '5.5.2', source: 'installed' }),
    })
    await client.chatStream(CREDENTIAL, bodyJson)
    if (init === undefined) throw new Error('fetch was not called')
    return init
  }

  function headersOf(init: RequestInit): Record<string, string> {
    return init.headers as Record<string, string>
  }

  it('sends the App User-Agent composed from the resolved version', async () => {
    const headers = headersOf(await captureChatInit('{"messages":[]}'))
    expect(headers['User-Agent']).toBe('WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/2.137.1')
  })

  it('narrows Accept to application/json on chat requests', async () => {
    const headers = headersOf(await captureChatInit('{"messages":[]}'))
    expect(headers['Accept']).toBe('application/json')
  })

  it('identifies itself as the WorkBuddy IDE at the resolved version', async () => {
    const headers = headersOf(await captureChatInit('{"messages":[]}'))
    expect(headers['X-IDE-Type']).toBe('WorkBuddy')
    expect(headers['X-IDE-Name']).toBe('WorkBuddy')
    expect(headers['X-IDE-Version']).toBe('5.5.2')
    expect(headers['X-Private-Data']).toBe('true')
  })

  it('mints a fresh dashless UUIDv4 conversation request id per request', async () => {
    const first = headersOf(await captureChatInit('{"messages":[]}'))
    const second = headersOf(await captureChatInit('{"messages":[]}'))
    // The request table records an accepted App request under the caller's own
    // dashless UUIDv4; a dashed id, or a server-generated `crb-…` UUIDv1,
    // signals the gateway did not take the caller for the App.
    const idPattern = /^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/
    expect(first['X-Conversation-Request-ID']).toMatch(idPattern)
    expect(second['X-Conversation-Request-ID']).toMatch(idPattern)
    // Fresh per request: reusing one would collapse distinct turns under a
    // single upstream id.
    expect(first['X-Conversation-Request-ID']).not.toBe(second['X-Conversation-Request-ID'])
  })

  it('emits the id in the same form the desktop client uses', async () => {
    // Shape taken from the client's own recorded id, so a regression shows up
    // as a concrete mismatch rather than a generic "looks random" assertion.
    const id = headersOf(await captureChatInit('{"messages":[]}'))['X-Conversation-Request-ID'] ?? ''
    expect(id).toHaveLength(32)
    expect(id).not.toContain('-')
    expect(id).toMatch(/^[0-9a-f]+$/)
  })

  it('keeps the existing credential headers unchanged', async () => {
    const headers = headersOf(await captureChatInit('{"messages":[]}'))
    expect(headers['X-User-Id']).toBe('uid-1')
    expect(headers['X-Domain']).toBe('www.codebuddy.cn')
    expect(headers['X-Product']).toBe('SaaS')
    expect(headers['Authorization']).toBe('Bearer at')
    expect(headers['X-Enterprise-Id']).toBeUndefined()
    expect(headers['X-No-Enterprise-Id']).toBe('1')
  })

  it('gzips the body and declares the encoding', async () => {
    const big = JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(4096) }] })
    const init = await captureChatInit(big)
    const headers = headersOf(init)
    expect(headers['Content-Encoding']).toBe('gzip')
    const body = init.body as Uint8Array
    expect(body.byteLength).toBeLessThan(Buffer.byteLength(big, 'utf8'))
    // Round-trip: the bytes must still decode to the prepared body.
    expect(JSON.parse(gunzipSync(body).toString('utf8'))).toEqual(JSON.parse(big))
  })

  it('gzips unconditionally, so encoding never varies with body size', async () => {
    // The client sends the header regardless of size; a size-dependent encoding
    // would make a small request look unlike the App's.
    const init = await captureChatInit('{"messages":[]}')
    const headers = headersOf(init)
    expect(headers['Content-Encoding']).toBe('gzip')
    expect(JSON.parse(gunzipSync(init.body as Uint8Array).toString('utf8'))).toEqual({ messages: [] })
  })

  it('reuses one app-version resolution across requests', async () => {
    const resolver = vi.fn(async () => ({ version: '5.5.2', source: 'installed' as const }))
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse('data: {}\n\n')))
    const client = new WorkBuddyUpstreamClient({ resolveAppVersion: resolver })
    await client.chatStream(CREDENTIAL, '{"messages":[]}')
    await client.chatStream(CREDENTIAL, '{"messages":[]}')
    // Reading the App plist per message would be wasteful on the hot path.
    expect(resolver).toHaveBeenCalledTimes(1)
  })

  it('falls back to the compiled-in version when the resolver fails', async () => {
    let headers: Record<string, string> | undefined
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, options?: RequestInit) => {
      headers = options?.headers as Record<string, string>
      return fakeResponse('data: {}\n\n')
    }))
    const client = new WorkBuddyUpstreamClient({
      resolveAppVersion: async () => { throw new Error('no plist') },
    })
    await client.chatStream(CREDENTIAL, '{"messages":[]}')
    expect(headers?.['X-IDE-Version']).toBe('5.5.2')
    expect(headers?.['User-Agent']).toBe('WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/2.137.1')
  })
})

describe('WorkBuddyUpstreamClient.fetchModels', () => {
  /** Build the models-catalog envelope that `fetchModels` unwraps. */
  function modelsEnvelope(models: unknown[], cliIds: string[]): string {
    return JSON.stringify({
      code: 0,
      msg: 'ok',
      data: {
        models,
        agents: [{ name: 'cli', models: cliIds }],
      },
    })
  }

  it('propagates supportsImages per model, treating unknown or disabled as text-only', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(modelsEnvelope([
      { id: 'm-img', name: 'Image Model', maxInputTokens: 100_000, maxOutputTokens: 32_000, supportsImages: true },
      { id: 'm-muted', name: 'Multimodal Switched Off', maxInputTokens: 100_000, maxOutputTokens: 32_000, supportsImages: true, disabledMultimodal: true },
      { id: 'm-text', name: 'Text Model', maxInputTokens: 100_000, maxOutputTokens: 32_000, supportsImages: false },
      { id: 'm-unknown', name: 'No Modality Field', maxInputTokens: 100_000, maxOutputTokens: 32_000 },
      { id: 'm-noncli', name: 'Not A CLI Model', maxInputTokens: 100_000, maxOutputTokens: 32_000, supportsImages: true },
    ], ['m-img', 'm-muted', 'm-text', 'm-unknown']))))

    const models = await new WorkBuddyUpstreamClient().fetchModels(CREDENTIAL)
    const byId = new Map(models.map(model => [model.id, model]))

    expect(models).toHaveLength(4)
    expect(byId.get('m-img')?.supportsImages).toBe(true)
    expect(byId.get('m-muted')?.supportsImages).toBe(false)
    expect(byId.get('m-text')?.supportsImages).toBe(false)
    // Absent field means unknown capability; the conservative answer is text-only.
    expect(byId.get('m-unknown')?.supportsImages).toBe(false)
  })

  it('keeps the catalog shape (name, contextWindow, maxTokens) alongside the flag', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(modelsEnvelope([
      { id: 'm-1', name: 'Model One', maxInputTokens: 168_000, maxOutputTokens: 32_000, supportsImages: true },
    ], ['m-1']))))

    const models = await new WorkBuddyUpstreamClient().fetchModels(CREDENTIAL)
    expect(models).toHaveLength(1)
    expect(models[0]).toEqual({
      id: 'm-1',
      name: 'Model One',
      contextWindow: 168_000,
      maxTokens: 32_000,
      supportsImages: true,
      reasoning: { supports: false, onlyReasoning: false, canDisableThinking: true },
      billing: { free: false },
    })
  })

  it('parses reasoning and billing metadata from the upstream fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(modelsEnvelope([
      {
        id: 'm-reason',
        name: 'Reasoner',
        maxInputTokens: 100_000, maxOutputTokens: 32_000,
        supportsReasoning: true,
        reasoning: { supportedEfforts: ['low', 'high', 'xhigh'], defaultEffort: 'high', canDisableThinking: true },
      },
      {
        id: 'm-free',
        name: 'Freebie',
        maxInputTokens: 100_000, maxOutputTokens: 32_000,
        supportsReasoning: true,
        onlyReasoning: true,
        reasoning: { canDisableThinking: false },
        credits: 'x0.00',
        tags: ['craft', 'badge:限时免费:#FF0000'],
      },
      {
        id: 'm-plain',
        name: 'Plain',
        maxInputTokens: 100_000, maxOutputTokens: 32_000,
      },
    ], ['m-reason', 'm-free', 'm-plain']))))

    const models = await new WorkBuddyUpstreamClient().fetchModels(CREDENTIAL)
    const byId = new Map(models.map(model => [model.id, model]))

    expect(byId.get('m-reason')?.reasoning).toEqual({
      supports: true,
      onlyReasoning: false,
      supportedEfforts: ['low', 'high', 'xhigh'],
      defaultEffort: 'high',
      canDisableThinking: true,
    })
    expect(byId.get('m-free')?.reasoning).toEqual({
      supports: true,
      onlyReasoning: true,
      canDisableThinking: false,
    })
    expect(byId.get('m-free')?.billing).toEqual({ credits: 'x0.00', badges: ['限时免费'], free: true })
    // A model with no reasoning or billing fields is explicitly non-reasoning
    // (supports: false) and carries no free/badge facts.
    expect(byId.get('m-plain')?.reasoning).toEqual({
      supports: false,
      onlyReasoning: false,
      canDisableThinking: true,
    })
    expect(byId.get('m-plain')?.billing).toEqual({ free: false })
  })
})

describe('WorkBuddyUpstreamClient.fetchCredits', () => {
  it('unwraps the nested envelope and aggregates total across accounts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
      { PackageName: 'pkg-a', CycleCapacitySize: 100, CycleCapacityRemain: 40 },
      { PackageName: 'pkg-b', CycleCapacitySize: 200, CycleCapacityRemain: 60 },
    ]))))

    const client = new WorkBuddyUpstreamClient()
    const credits = await client.fetchCredits(CREDENTIAL)

    expect(credits.total).toBe(100)
    expect(credits.accounts).toHaveLength(2)
    expect(credits.accounts[0]).toEqual({ packageName: 'pkg-a', remain: 40, size: 100 })
    expect(credits.accounts[1]).toEqual({ packageName: 'pkg-b', remain: 60, size: 200 })
  })

  it('selects cycle remain when size > 0 (first branch)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
      { PackageName: 'pkg', CycleCapacitySize: 100, CycleCapacityRemain: 30, CapacityRemain: 999 },
    ]))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    // First branch: size>0 → cycleRemain, ignoring the larger CapacityRemain.
    expect(credits.accounts[0]).toEqual({ packageName: 'pkg', remain: 30, size: 100 })
  })

  it('selects cycle remain when there is cycle usage even without size (second branch)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
      { PackageName: 'pkg', CycleCapacitySize: 0, CycleCapacityRemain: 20, CycleCapacityUsed: 5, CapacityRemain: 1 },
    ]))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    // Second branch: size<=0 but cycleUsed>0 → cycleRemain.
    expect(credits.accounts[0]).toEqual({ packageName: 'pkg', remain: 20, size: 0 })
  })

  it('falls back to capacity remain when no cycle fields (third branch)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
      { PackageName: 'pkg', CapacityRemain: 77 },
    ]))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    // Third branch: no size, no cycle → capacityRemain.
    expect(credits.accounts[0]).toEqual({ packageName: 'pkg', remain: 77, size: 0 })
  })

  it('clamps a negative remain to zero', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
      { PackageName: 'pkg', CycleCapacitySize: 100, CycleCapacityRemain: -50 },
    ]))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    expect(credits.accounts[0]!.remain).toBe(0)
    expect(credits.total).toBe(0)
  })

  it('falls back to CapacitySize for size when cycle size is absent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
      { PackageName: 'pkg', CapacitySize: 500, CapacityRemain: 120 },
    ]))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    // size falls back to CapacitySize=500; remain from third branch = 120.
    expect(credits.accounts[0]).toEqual({ packageName: 'pkg', remain: 120, size: 500 })
  })

  it('labels a missing package name as (unnamed)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
      { CycleCapacitySize: 10, CycleCapacityRemain: 5 },
    ]))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    expect(credits.accounts[0]!.packageName).toBe('(unnamed)')
  })

  it('returns an empty list for an empty Accounts array', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([]))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    expect(credits.total).toBe(0)
    expect(credits.accounts).toEqual([])
  })

  it('skips non-object account entries', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
      null,
      'not-an-object',
      42,
      { PackageName: 'valid', CycleCapacitySize: 10, CycleCapacityRemain: 7 },
    ]))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    expect(credits.accounts).toHaveLength(1)
    expect(credits.accounts[0]!.packageName).toBe('valid')
  })

  it('throws when the upstream business code is non-zero', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(
      JSON.stringify({ code: 1, msg: 'billing error' }),
    )))

    await expect(new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)).rejects.toThrow(/billing error/)
  })

  it('throws when the upstream returns non-JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse('not json')))

    await expect(new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)).rejects.toThrow(/non-JSON/)
  })
})

describe('normalizeCredits', () => {
  it('keeps a bare multiplier untouched', () => {
    expect(normalizeCredits('x0.79')).toBe('x0.79')
    expect(normalizeCredits('x0.00')).toBe('x0.00')
  })

  it('strips a trailing credits unit word', () => {
    expect(normalizeCredits('x0.79 credits')).toBe('x0.79')
    expect(normalizeCredits('x1.62 credits')).toBe('x1.62')
    expect(normalizeCredits('x0.79 CREDITS')).toBe('x0.79')
    expect(normalizeCredits('x0.79 credit')).toBe('x0.79')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeCredits('  x0.79 credits  ')).toBe('x0.79')
  })

  it('returns undefined for absent or empty values', () => {
    expect(normalizeCredits(undefined)).toBeUndefined()
    expect(normalizeCredits('')).toBeUndefined()
    expect(normalizeCredits('   ')).toBeUndefined()
    expect(normalizeCredits('credits')).toBeUndefined()
  })
})
