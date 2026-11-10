/**
 * Cloudflare Pages Function: serves /api/proxy for a CHAD site hosted on Cloudflare Pages.
 * All the logic (and the security rules) are in proxy/core.mjs. Deploy steps: docs/BYOK_AI.md.
 */
import { handleProxy } from '../../proxy/core.mjs';

export function onRequest(context) {
  return handleProxy(context.request, context.env ?? {});
}
