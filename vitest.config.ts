import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    testTimeout: 15_000,
    setupFiles: ['test/setup-env.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary'],
      include: [
        'src/auto-update.ts',
        'src/update-checkout.ts',
        'src/config.ts',
        'src/account-state.ts',
        'src/selectors.ts',
        'src/cache.ts',
        'src/processes.ts',
        'src/trash.ts',
        'src/providers/**/*.ts',
      ],
      thresholds: { branches: 80 },
    },
  },
});
