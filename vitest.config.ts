import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Load .env into process.env so DB-backed tests (security suite) can run locally.
    setupFiles: ['dotenv/config'],
    include: [
      'src/**/__tests__/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    exclude: ['node_modules', 'dist'],
  },
})
