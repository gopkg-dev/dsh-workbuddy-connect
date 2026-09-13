import { createServer, request as httpRequest, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProbeKey, workBuddyProbeHandler, type WorkBuddyProbeRouteOptions } from '../src/probe-route.ts'

/**
 * Offline tests for the probe control route, the plugin's only state-changing
 * endpoint. Two guards must both hold before anything happens: the loopback
 * Host/Origin check (drops DNS-rebinding pages) and the in-process key (proves
 * the caller was the same-origin card, since any local process can write
 * `Host: 127.0.0.1`).
 */

let server: Server | undefined

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>(resolve => server?.close(() => resolve()))
    server = undefined
  }
})

/** Mount the handler on an ephemeral port and return its origin + key. */
async function mount(deps?: Partial<WorkBuddyProbeRouteOptions>): Promise<{ origin: string; key: string; calls: string[] }> {
  const key = createProbeKey()
  const calls: string[] = []
  const handler = workBuddyProbeHandler({
    probe: async modelId => {
      calls.push(modelId)
      return { state: 'ok' }
    },
    clear: () => { calls.push('clear') },
    ...deps,
  }, key)
  server = createServer((req, res) => { void handler(req, res) })
  await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { origin: `http://127.0.0.1:${address.port}`, key, calls }
}

/** POST one control action. */
async function post(
  origin: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(origin, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

/**
 * POST with full control over the request headers, including `Host`, which
 * `fetch` refuses to set. Needed to exercise the rebinding guard.
 */
async function postRaw(
  origin: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = new URL(origin)
  const payload = JSON.stringify(body)
  return await new Promise((resolve, reject) => {
    const request = httpRequest({
      host: url.hostname,
      port: url.port,
      path: '/',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(chunk as Buffer))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed: Record<string, unknown> = {}
        try { parsed = JSON.parse(text) as Record<string, unknown> } catch { /* leave empty */ }
        resolve({ status: response.statusCode ?? 0, body: parsed })
      })
    })
    request.on('error', reject)
    request.end(payload)
  })
}

describe('probe control route', () => {
  it('saves only a catalog-supported context window behind the existing key guard', async () => {
    const setContextWindow = vi.fn(async () => true)
    const { origin, key } = await mount({
      models: () => [{ id: 'model', name: 'Model', contextWindow: 300_000, supportedContextWindows: [1_000_000, 300_000, 300_000], maxTokens: 1000, supportsImages: false }],
      setContextWindow,
    })
    const action = { action: 'context-window', model: 'model', contextWindow: 1_000_000 }
    expect((await post(origin, action)).status).toBe(403)
    expect(setContextWindow).not.toHaveBeenCalled()
    const result = await post(origin, action, { 'X-WorkBuddy-Probe-Key': key })
    expect(result).toEqual({ status: 200, body: { state: 'updated', model: 'model', contextWindow: 1_000_000 } })
    expect(setContextWindow).toHaveBeenCalledExactlyOnceWith('model', 1_000_000)
  })

  it('refuses unknown models, unsupported tiers, and malformed context values before writing', async () => {
    const setContextWindow = vi.fn(async () => true)
    const { origin, key } = await mount({
      models: () => [{ id: 'model', name: 'Model', contextWindow: 300_000, supportedContextWindows: [300_000, 1_000_000], maxTokens: 1000, supportsImages: false }],
      setContextWindow,
    })
    const headers = { 'X-WorkBuddy-Probe-Key': key }
    expect((await post(origin, { action: 'context-window', model: 'missing', contextWindow: 1_000_000 }, headers)).body)
      .toEqual({ error: 'unknown-model' })
    expect((await post(origin, { action: 'context-window', model: 'model', contextWindow: 500_000 }, headers)).body)
      .toEqual({ error: 'unsupported-context-window' })
    for (const contextWindow of [undefined, null, '1000000', 0, -1, 300_000.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect((await post(origin, { action: 'context-window', model: 'model', contextWindow }, headers)).status).toBe(400)
    }
    expect((await post(origin, { action: 'context-window', contextWindow: 300_000 }, headers)).status).toBe(400)
    expect(setContextWindow).not.toHaveBeenCalled()
  })

  it('uses only the default when a model has no supported list, even with a larger maxInputTokens', async () => {
    const setContextWindow = vi.fn(async () => true)
    const { origin, key } = await mount({
      models: () => [{ id: 'model', name: 'Model', contextWindow: 300_000, maxInputTokens: 1_000_000, maxTokens: 1000, supportsImages: false }],
      setContextWindow,
    })
    const headers = { 'X-WorkBuddy-Probe-Key': key }
    expect((await post(origin, { action: 'context-window', model: 'model', contextWindow: 1_000_000 }, headers)).status).toBe(400)
    expect((await post(origin, { action: 'context-window', model: 'model', contextWindow: 300_000 }, headers)).status).toBe(200)
    expect(setContextWindow).toHaveBeenCalledExactlyOnceWith('model', 300_000)
  })

  it('reports unavailable settings and persistence failures without claiming a successful update', async () => {
    const setContextWindow = vi.fn<NonNullable<WorkBuddyProbeRouteOptions['setContextWindow']>>()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('storage unavailable'))
    const { origin, key } = await mount({
      models: () => [{ id: 'model', name: 'Model', contextWindow: 300_000, maxTokens: 1000, supportsImages: false }],
      setContextWindow,
    })
    const action = { action: 'context-window', model: 'model', contextWindow: 300_000 }
    const headers = { 'X-WorkBuddy-Probe-Key': key }
    expect((await post(origin, action, headers)).status).toBe(503)
    expect((await post(origin, action, headers)).status).toBe(500)
  })

  it('accepts a probe carrying the correct key', async () => {
    const { origin, key, calls } = await mount()
    const result = await post(origin, { action: 'probe', model: 'auto' }, { 'X-WorkBuddy-Probe-Key': key })
    expect(result.status).toBe(200)
    expect(result.body['state']).toBe('ok')
    expect(calls).toEqual(['auto'])
  })

  it('rejects a probe with no key', async () => {
    const { origin, calls } = await mount()
    const result = await post(origin, { action: 'probe', model: 'auto' })
    expect(result.status).toBe(403)
    expect(result.body['error']).toBe('invalid-probe-key')
    // Nothing was spent.
    expect(calls).toEqual([])
  })

  it('rejects a wrong key of the same length', async () => {
    const { origin, key, calls } = await mount()
    const wrong = `${key.slice(0, -1)}${key.endsWith('a') ? 'b' : 'a'}`
    const result = await post(origin, { action: 'probe', model: 'auto' }, { 'X-WorkBuddy-Probe-Key': wrong })
    expect(result.status).toBe(403)
    expect(calls).toEqual([])
  })

  it('rejects a non-loopback Host even with the right key', async () => {
    const { origin, key, calls } = await mount()
    // `fetch` refuses to set a `Host` header (it is a forbidden header name),
    // so a spoofed Host has to go through the raw HTTP client — which is
    // exactly what a DNS-rebinding page's request looks like on the wire.
    const result = await postRaw(origin, { action: 'probe', model: 'auto' }, {
      'X-WorkBuddy-Probe-Key': key,
      'Host': 'attacker.example',
    })
    expect(result.status).toBe(403)
    expect(result.body['error']).toBe('request-not-trusted')
    expect(calls).toEqual([])
  })

  it('rejects a non-loopback Origin even with the right key', async () => {
    const { origin, key, calls } = await mount()
    const result = await post(origin, { action: 'probe', model: 'auto' }, {
      'X-WorkBuddy-Probe-Key': key,
      'Origin': 'https://attacker.example',
    })
    expect(result.status).toBe(403)
    expect(calls).toEqual([])
  })

  it('refuses GET', async () => {
    const { origin, key } = await mount()
    const response = await fetch(origin, { headers: { 'X-WorkBuddy-Probe-Key': key } })
    expect(response.status).toBe(405)
  })

  it('rejects a malformed action, and a probe with no model', async () => {
    const { origin, key, calls } = await mount()
    const headers = { 'X-WorkBuddy-Probe-Key': key }
    expect((await post(origin, { action: 'nope' }, headers)).status).toBe(400)
    expect((await post(origin, { action: 'probe' }, headers)).status).toBe(400)
    expect((await post(origin, { action: 'probe', model: '   ' }, headers)).status).toBe(400)
    expect((await post(origin, 'not json', headers)).status).toBe(400)
    expect(calls).toEqual([])
  })

  it('rejects an oversized body', async () => {
    const { origin, key } = await mount()
    const result = await post(origin, { action: 'probe', model: 'x'.repeat(5000) }, { 'X-WorkBuddy-Probe-Key': key })
    expect(result.status).toBe(413)
  })

  it('accepts a clear action', async () => {
    const { origin, key, calls } = await mount()
    const result = await post(origin, { action: 'clear' }, { 'X-WorkBuddy-Probe-Key': key })
    expect(result.status).toBe(200)
    expect(calls).toEqual(['clear'])
  })

  it('mints a distinct key per call', () => {
    expect(createProbeKey()).not.toBe(createProbeKey())
  })
})
