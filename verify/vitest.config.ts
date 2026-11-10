/**
 * Independent print verification (docs/PRINT_VERIFICATION.md). Run with `npm run verify:print`.
 * Separate from `npm test`: it writes the test set's STL and STEP files to verify/print/out/
 * for the Python checker (verify/print/check_parts.py), which needs extra tools.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['verify/**/*.verify.ts'],
    testTimeout: 1_800_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
