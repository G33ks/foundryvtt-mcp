import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.js'],
    env: {
      NODE_ENV: 'test',
      FOUNDRY_URL: 'http://localhost:30000',
      LOG_LEVEL: 'error', // Reduce log noise in tests
      // Never read the developer's own configuration file (config/sources.ts).
      FOUNDRY_MCP_CONFIG: '__vitest_no_config_file__.env',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.d.ts',
        'src/types/**/*',
      ],
    },
  },
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
});
