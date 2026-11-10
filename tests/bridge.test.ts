import { describe, it, expect, afterAll } from 'vitest';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import WebSocket from 'ws';
// @ts-expect-error plain JS module
import { attachBridge, resolveClaude } from '../bridge/hub.mjs';

describe('bridge hub + MCP server', () => {
  const http = createServer();
  let bridge: any;
  afterAll(() => { bridge?.close(); http.close(); });

  it('resolves Claude Code from an explicit path', () => {
    expect(resolveClaude({ CHATCAD_CLAUDE_PATH: 'C:\\tools\\claude.exe' }, 'win32')).toEqual({ path: 'C:\\tools\\claude.exe', shell: false });
  });

  it('finds the native Windows install even when PATH is stale', () => {
    const r = resolveClaude({ USERPROFILE: 'C:\\Users\\Example' }, 'win32', (p: string) => p.endsWith('claude.exe'));
    expect(r?.shell).toBe(false);
    expect(r?.path).toMatch(/\.local[\\/]bin[\\/]claude\.exe$/);
  });

  it('routes MCP tool calls to the app window and results back', async () => {
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
    const port = (http.address() as any).port;
    bridge = attachBridge(http, { port, claudeCmd: null });

    // Fake app window: answers every tool call.
    const app = new WebSocket(`ws://127.0.0.1:${port}/chatcad-bridge?role=app`, { headers: { origin: `http://localhost:${port}` } });
    const status: any = await new Promise((r) => app.once('message', (d) => r(JSON.parse(String(d)))));
    expect(status.type).toBe('status');
    expect(status.claude.found).toBe(false);
    app.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.type === 'tool_call') app.send(JSON.stringify({ type: 'tool_result', callId: m.callId, ok: m.name !== 'undo', result: { echo: m.name, args: m.args }, error: 'nope' }));
    });

    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: ['bridge/mcp-server.mjs'],
      env: { ...process.env as Record<string, string>, CHATCAD_URL: `ws://127.0.0.1:${port}/chatcad-bridge`, CHATCAD_TOKEN: bridge.token },
    }));
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain('create_sketch');
    const ok: any = await client.callTool({ name: 'extrude', arguments: { sketch_id: 'sk1', depth: 1 } });
    expect(JSON.parse(ok.content[0].text)).toEqual({ echo: 'extrude', args: { sketch_id: 'sk1', depth: 1 } });
    const bad: any = await client.callTool({ name: 'undo', arguments: {} });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/nope/);
    await client.close();
    app.close();
  });

  it('tells the app how to install Claude Code when it is missing', async () => {
    const port = (http.address() as any).port;
    const app = new WebSocket(`ws://127.0.0.1:${port}/chatcad-bridge?role=app`);
    await new Promise((r) => app.once('message', r));
    app.send(JSON.stringify({ type: 'chat', id: 'x', text: 'hi' }));
    const done: any = await new Promise((r) => app.on('message', (d) => { const m = JSON.parse(String(d)); if (m.type === 'chat_done') r(m); }));
    expect(done.ok).toBe(false);
    expect(done.error).toMatch(/not found/);
    app.close();
  });

  it('rejects connections with a foreign origin', async () => {
    const port = (http.address() as any).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/chatcad-bridge?role=app`, { headers: { origin: 'https://evil.example' } });
    const outcome = await new Promise((r) => { ws.on('open', () => r('open')); ws.on('error', () => r('rejected')); });
    expect(outcome).toBe('rejected');
  });
});
