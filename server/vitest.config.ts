import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    env: { NODE_ENV: 'test' },
    testTimeout: 20_000,
    // Hooks build indexes and hash passwords, which is slow when every file runs at once.
    hookTimeout: 30_000,
    globalSetup: ['./tests/support/globalSetup.ts'],
    setupFiles: ['./tests/support/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/server.ts'],
    },
  },
})
