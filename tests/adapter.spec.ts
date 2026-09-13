import { describe, expect, it } from 'vitest'
import { createWorkBuddyAdapter } from '../src/adapter.ts'
import { WorkBuddyCatalog } from '../src/catalog.ts'
import { WORKBUDDY_PROVIDER } from '../src/adapter.ts'
import type { WorkBuddyCredentialStore } from '../src/auth.ts'
import type { WorkBuddyShim } from '../src/shim.ts'
import type { WorkBuddyProbeRecord } from '../src/probe-store.ts'
import { resolveContextWindow, supportedContextWindows } from '../src/context-windows.ts'

/** The pi-ai collection built by an adapter exposes the exact model descriptor it consumes. */
interface AdapterSnapshot {
  models: {
    getModel(provider: string, model: string): { contextWindow: number; maxTokens: number; compat?: { maxTokensField?: string } } | undefined
  }
}

describe('WorkBuddy adapter model descriptors', () => {
  it('rechecks expiring probe observations on new calls while preserving prepared calls', async () => {
    const catalog = new WorkBuddyCatalog([{
      id: 'model', name: 'Model', contextWindow: 300_000, maxTokens: 64_000,
      supportsImages: false, reasoning: { supports: true, onlyReasoning: true, canDisableThinking: false },
    }])
    let observed: WorkBuddyProbeRecord | undefined = {
      fingerprint: 'test', validation: 'validating', efforts: ['high'], probedAtMs: 1,
      pluginVersion: 'test', account: 'test-account',
    }
    const { adapter } = createWorkBuddyAdapter({
      catalog,
      observe: () => observed,
      store: {} as WorkBuddyCredentialStore,
      shim: { baseUrl: () => 'http://127.0.0.1:1', token: () => 'test-token' } as WorkBuddyShim,
    })
    const prepared = await adapter.prepareCall(WORKBUDDY_PROVIDER, 'model')
    expect(prepared.model.reasoning?.efforts.map(effort => effort.id)).toEqual(['high'])
    // recordFor() returns undefined when its record expires, without emitting
    // a catalog/settings invalidation event.
    observed = undefined
    expect((await adapter.resolveModel(WORKBUDDY_PROVIDER, 'model')).reasoning).toBeUndefined()
    expect(prepared.model.reasoning?.efforts.map(effort => effort.id)).toEqual(['high'])
  })

  it('applies a saved window to resolved models and new snapshots without changing the catalog', async () => {
    const catalog = new WorkBuddyCatalog([{
      id: 'model', name: 'Model', contextWindow: 300_000, maxInputTokens: 1_000_000,
      supportedContextWindows: [300_000, 1_000_000], maxTokens: 64_000, supportsImages: false,
    }])
    let selected: number | undefined
    const { adapter, invalidate } = createWorkBuddyAdapter({
      catalog,
      contextWindowFor: id => id === 'model' ? selected : undefined,
      store: {} as WorkBuddyCredentialStore,
      shim: { baseUrl: () => 'http://127.0.0.1:1', token: () => 'test-token' } as WorkBuddyShim,
    })
    const current = (): AdapterSnapshot => (adapter as unknown as { current(): AdapterSnapshot }).current()
    const before = current()
    expect((await adapter.resolveModel(WORKBUDDY_PROVIDER, 'model')).context?.contextWindow).toBe(300_000)
    const prepared = await adapter.prepareCall(WORKBUDDY_PROVIDER, 'model')

    selected = 1_000_000
    invalidate()
    expect((await adapter.resolveModel(WORKBUDDY_PROVIDER, 'model')).context?.contextWindow).toBe(1_000_000)
    expect((await adapter.prepareCall(WORKBUDDY_PROVIDER, 'model')).model.context?.contextWindow).toBe(1_000_000)
    expect(prepared.model.context?.contextWindow).toBe(300_000)
    expect(current().models.getModel(WORKBUDDY_PROVIDER, 'model')).toMatchObject({ contextWindow: 1_000_000, maxTokens: 64_000 })
    expect(before.models.getModel(WORKBUDDY_PROVIDER, 'model')?.contextWindow).toBe(300_000)
    expect(catalog.current()[0]?.contextWindow).toBe(300_000)

    // An upstream refresh may remove a tier; stale preferences cannot keep it alive.
    catalog.set([{
      id: 'model', name: 'Model', contextWindow: 400_000,
      supportedContextWindows: [400_000], maxTokens: 64_000, supportsImages: false,
    }])
    invalidate()
    expect((await adapter.resolveModel(WORKBUDDY_PROVIDER, 'model')).context?.contextWindow).toBe(400_000)
  })

  it('uses WorkBuddy\'s max_tokens output-cap field', () => {
    const catalog = new WorkBuddyCatalog([{
      id: 'model', name: 'Model', contextWindow: 1_000, maxTokens: 128_000,
      supportsImages: false, billing: { free: false },
    }])
    const { adapter } = createWorkBuddyAdapter({
      catalog,
      store: {} as WorkBuddyCredentialStore,
      shim: {
        ready: Promise.resolve(),
        baseUrl: () => 'http://127.0.0.1:1',
        token: () => 'test-token',
        close: async () => {},
      } as WorkBuddyShim,
    })

    // `current()` is private in the adapter's public API, but this is the
    // descriptor seam pi-ai reads before it serializes a request.
    const snapshot = (adapter as unknown as { current(): AdapterSnapshot }).current()
    expect(snapshot.models.getModel(WORKBUDDY_PROVIDER, 'model')?.compat?.maxTokensField).toBe('max_tokens')
  })
})

describe('context window selection', () => {
  it('keeps the default until a declared alternative is selected', () => {
    const model = { contextWindow: 300_000, supportedContextWindows: [300_000, 1_000_000] }
    expect(resolveContextWindow(model)).toBe(300_000)
    expect(resolveContextWindow(model, 1_000_000)).toBe(1_000_000)
    expect(resolveContextWindow(model, 500_000)).toBe(300_000)
  })

  it.each([undefined, [], [0, -1, NaN, Infinity, 1.5]])('falls back to contextWindow without usable alternatives: %j', values => {
    const model = { contextWindow: 300_000, maxInputTokens: 1_000_000, ...(values === undefined ? {} : { supportedContextWindows: values }) }
    expect(supportedContextWindows(model)).toEqual([300_000])
    expect(resolveContextWindow(model, 1_000_000)).toBe(300_000)
  })

  it('normalizes declared choices without mutating the source', () => {
    const declared = [1_000_000, 0, 300_000, 300_000, Infinity, 1.5]
    expect(supportedContextWindows({ contextWindow: 300_000, supportedContextWindows: declared })).toEqual([300_000, 1_000_000])
    expect(declared).toEqual([1_000_000, 0, 300_000, 300_000, Infinity, 1.5])
  })
})
