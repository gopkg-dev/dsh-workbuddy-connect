import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

/** Mirror the build-time define from tsdown.config.ts so tests see the same version. */
const PACKAGE = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { name: string; version: string }

export default defineConfig({
  define: {
    __DSH_WORKBUDDY_VERSION__: JSON.stringify(PACKAGE.version),
    __DSH_WORKBUDDY_PACKAGE__: JSON.stringify(PACKAGE.name),
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
  },
})
