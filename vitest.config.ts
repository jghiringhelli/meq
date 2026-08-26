import { defineConfig } from 'vitest/config';

// Vitest runs the exhaustive per-card / per-ability engine unit suites in test/.
// The legacy custom runner (scripts/run-all-tests.mjs, `npm test`) still exists
// and covers integration/coverage checks; these Vitest suites add one named test
// per game entity (every card, ability, encounter, event, peril, plot, etc.).
export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
    hideSkippedTests: true,
  },
});
