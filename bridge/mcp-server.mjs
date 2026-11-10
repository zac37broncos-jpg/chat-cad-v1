#!/usr/bin/env node
/**
 * CHAD MCP server (stdio).
 *
 * Claude (headless Claude Code started by the in-app chat, or the Claude
 * desktop app) launches this process. Each tool call is forwarded over a
 * local WebSocket to the CHAD window, which executes it with the same
 * commands as the toolbar and returns the exact result.
 *
 * Env: CHATCAD_URL (default ws://localhost:<port in brand.json>/chatcad-bridge), CHATCAD_TOKEN.
 * (The CHATCAD_ names are historical internal names; see src/brand.ts.)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import WebSocket from 'ws';

const here = dirname(fileURLToPath(import.meta.url));
const readTools = (f) => JSON.parse(readFileSync(join(here, '..', 'src', 'ai', f), 'utf8'));
const TOOLS = [...readTools('tools.json'), ...readTools('featureTools.json'), ...readTools('organicTools.json'), ...readTools('batchTool.json')];
const BRAND = JSON.parse(readFileSync(join(here, '..', 'brand.json'), 'utf8'));
const APP_NAME = BRAND.name;
const URL_ = process.env.CHATCAD_URL || `ws://localhost:${BRAND.port}/chatcad-bridge`;
const TOKEN = process.env.CHATCAD_TOKEN || '';
const TIMEOUT_MS = 120_000;
/** A whole-model build_model call regenerates a large part; give it longer. */
const timeoutFor = (name) => (name === 'build_model' ? 900_000 : TIMEOUT_MS);

let ws = null;
let connecting = null;
let seq = 0;
const pending = new Map();

function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve(ws);
  if (connecting) return connecting;
  connecting = new Promise((resolve, reject) => {
    const sock = new WebSocket(`${URL_}?role=mcp&token=${encodeURIComponent(TOKEN)}`);
    sock.on('open', () => { ws = sock; connecting = null; resolve(sock); });
    sock.on('error', (e) => { connecting = null; reject(new Error(`Cannot reach the ${APP_NAME} window at ${URL_}. Is "npm run dev" running and the app open? (${e.message})`)); });
    sock.on('close', () => {
      ws = null;
      for (const [, p] of pending) p.reject(new Error(`${APP_NAME} window disconnected`));
      pending.clear();
    });
    sock.on('message', (raw) => {
      let m; try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.type !== 'tool_result') return;
      const p = pending.get(m.callId);
      if (!p) return;
      pending.delete(m.callId);
      clearTimeout(p.timer);
      if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error || 'Tool failed'));
    });
  });
  return connecting;
}

async function callApp(name, args) {
  const sock = await connect();
  const callId = `c${Date.now().toString(36)}_${++seq}`;
  return new Promise((resolve, reject) => {
    const ms = timeoutFor(name);
    const timer = setTimeout(() => { pending.delete(callId); reject(new Error(`${APP_NAME} did not answer ${name} within ${ms / 1000}s`)); }, ms);
    pending.set(callId, { resolve, reject, timer });
    sock.send(JSON.stringify({ type: 'tool_call', callId, name, args: args ?? {} }));
  });
}

const server = new Server({ name: 'chatcad', version: '0.2.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    const result = await callApp(req.params.name, req.params.arguments);
    // Renders (view_model) go back as real images so Claude can see the part.
    const images = result && typeof result === 'object' && Array.isArray(result.images) ? result.images : [];
    const rest = images.length ? { ...result, images: undefined } : result;
    return {
      content: [
        { type: 'text', text: JSON.stringify(rest, null, 1) },
        ...images.map((im) => ({ type: 'image', data: im.data, mimeType: im.mimeType || 'image/png' })),
      ],
    };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
  }
});

await server.connect(new StdioServerTransport());
