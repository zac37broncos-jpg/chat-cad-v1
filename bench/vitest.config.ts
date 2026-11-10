/**
 * Benchmark suite. Run with `npm run bench`.
 * Separate from `npm test`: timings are reported, never asserted, so a slow
 * machine cannot fail the build. Results go to bench-results/latest.json.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['bench/**/*.bench.test.ts'],
    testTimeout: 900_000,
    hookTimeout: 120_000,
    // One file, one worker: timings must not compete with each other.
    fileParallelism: false,
  },
});
