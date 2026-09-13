import type { WorkBuddyModelInfo } from './catalog.ts'

type ContextWindowInfo = Pick<WorkBuddyModelInfo, 'contextWindow' | 'supportedContextWindows'>

/** Normalize the upstream list without inferring alternatives from a ceiling. */
export function declaredContextWindows(info: ContextWindowInfo): number[] {
  const declared = Array.isArray(info.supportedContextWindows)
    ? info.supportedContextWindows.filter(value => Number.isSafeInteger(value) && value > 0)
    : []
  return [...new Set(declared)].sort((a, b) => a - b)
}

/** Use only declared windows; a catalog without alternatives keeps its default. */
export function supportedContextWindows(info: ContextWindowInfo): number[] {
  const declared = declaredContextWindows(info)
  if (declared.length > 0) return declared
  return Number.isSafeInteger(info.contextWindow) && info.contextWindow > 0 ? [info.contextWindow] : []
}

/** Stale or unsupported preferences fall back to the current catalog default. */
export function resolveContextWindow(info: ContextWindowInfo, selected?: number): number {
  return selected !== undefined && supportedContextWindows(info).includes(selected)
    ? selected
    : info.contextWindow
}
