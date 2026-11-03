import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    env: { NODE_ENV: 'test' },
    globalSetup: ['./tests/support/globalSetup.ts'],
    setupFiles: ['./tests/support/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/server.ts'],
    },
  },
})
