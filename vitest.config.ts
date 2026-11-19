import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // The database suites share a CPU-capped CI runner; the 5 s default is too tight for them.
    testTimeout: 20_000,
  },
})
