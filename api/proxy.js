/**
 * Vercel Function: serves /api/proxy for a CHAD site hosted on Vercel.
 * All the logic (and the security rules) are in proxy/core.mjs. Deploy steps: docs/BYOK_AI.md.
 */
import { handleProxy } from '../proxy/core.mjs';

// Time limit and request cancellation (Stop button) are set in vercel.json.
export default {
  fetch(request) {
    return handleProxy(request, { ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS ?? '' });
  },
};
