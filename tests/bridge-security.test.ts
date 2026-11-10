/**
 * Bridge security and tool-call cleanup.
 * Uses tests/fixtures/fake-claude.mjs: no real Claude Code, no usage.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import WebSocket from 'ws';
// @ts-expect-error plain JS module
import { attachBridge, upgradeAllowed, WINDOW_CLOSED, killTree } from '../bridge/hub.mjs';

const FAKE = { path: resolve('tests/fixtures/fake-claude.mjs'), shell: false };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 10000) {
  for (let t = 0; t < ms && !cond(); t += 25) await wait(25);
  if (!cond()) throw new Error('timed out');
}

/** Opens a fake CHAD window. Answers tool calls with { window: name } unless told to stay silent. */
async function openApp(port: number, name: string, answer = true) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/chatcad-bridge?role=app`, { headers: { origin: `http://localhost:${port}` } });
  const msgs: any[] = [];
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    msgs.push(m);
    if (answer && m.type === 'tool_call') ws.send(JSON.stringify({ type: 'tool_result', callId: m.callId, ok: true, result: { window: name } }));
  });
  await new Promise((r) => ws.once('open', r));
  await until(() => msgs.some((m) => m.type === 'status'));
  return { ws, msgs };
}

function tryConnect(url: string, headers: Record<string, string> = {}) {
  return new Promise<'open' | 'rejected'>((r) => {
    const ws = new WebSocket(url, { headers });
    ws.on('open', () => { ws.close(); r('open'); });
    ws.on('error', () => r('rejected'));
  });
}

describe('bridge security (B4)', () => {
  const http = createServer();
  let bridge: any;
  let port = 0;
  beforeAll(async () => {
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
    port = (http.address() as any).port;
    bridge = attachBridge(http, { port, claudeCmd: FAKE, loggedIn: true });
  });
  afterAll(() => { bridge?.close(); http.close(); });

  it('decides which connections may upgrade', () => {
    // MCP: only local programs, which never send an Origin header.
    expect(upgradeAllowed('mcp', undefined, 5173)).toBe(true);
    expect(upgradeAllowed('mcp', 'https://evil.example', 5173)).toBe(false);
    expect(upgradeAllowed('mcp', 'http://localhost:5173', 5173)).toBe(false);
    expect(upgradeAllowed('mcp', '', 5173)).toBe(false);
    expect(upgradeAllowed('mcp', 'null', 5173)).toBe(false);
    // App: this server's own page only.
    expect(upgradeAllowed('app', 'http://localhost:5173', 5173)).toBe(true);
    expect(upgradeAllowed('app', 'http://127.0.0.1:5173', 5173)).toBe(true);
    expect(upgradeAllowed('app', 'http://[::1]:5173', 5173)).toBe(true);
    expect(upgradeAllowed('app', undefined, 5173)).toBe(true);
    expect(upgradeAllowed('app', 'http://localhost:3000', 5173)).toBe(false);
    expect(upgradeAllowed('app', 'http://localhost', 5173)).toBe(false);
    expect(upgradeAllowed('app', 'http://localhost.evil.example:5173', 5173)).toBe(false);
    expect(upgradeAllowed('app', 'http://evil.example:5173', 5173)).toBe(false); // DNS rebinding
    expect(upgradeAllowed('app', 'https://localhost:5173', 5173)).toBe(false);
    expect(upgradeAllowed('app', 'null', 5173)).toBe(false);
    expect(upgradeAllowed(null, undefined, 5173)).toBe(false);
    expect(upgradeAllowed('admin', undefined, 5173)).toBe(false);
  });

  it('refuses a web page that tries to connect as an MCP client', async () => {
    const url = `ws://127.0.0.1:${port}/chatcad-bridge?role=mcp`;
    expect(await tryConnect(url, { origin: 'https://evil.example' })).toBe('rejected');
    expect(await tryConnect(url, { origin: `http://localhost:${port}` })).toBe('rejected');
    expect(await tryConnect(url)).toBe('open'); // Node MCP server (no Origin)
  });

  it('refuses app connections from other sites and other local ports', async () => {
    const url = `ws://127.0.0.1:${port}/chatcad-bridge?role=app`;
    expect(await tryConnect(url, { origin: 'http://localhost:3000' })).toBe('rejected');
    expect(await tryConnect(url, { origin: `http://evil.example:${port}` })).toBe('rejected');
    expect(await tryConnect(url, { origin: `http://localhost:${port}` })).toBe('open');
    expect(await tryConnect(`ws://127.0.0.1:${port}/chatcad-bridge?role=other`)).toBe('rejected');
  });

  it('fails a pending tool call at once when the window closes', async () => {
    const app = await openApp(port, 'A', false);
    const mcp = new WebSocket(`ws://127.0.0.1:${port}/chatcad-bridge?role=mcp`);
    await new Promise((r) => mcp.once('open', r));
    const results: any[] = [];
    mcp.on('message', (d) => results.push(JSON.parse(String(d))));
    mcp.send(JSON.stringify({ type: 'tool_call', callId: 'mine1', name: 'get_model_state', args: {} }));
    await until(() => app.msgs.some((m) => m.type === 'tool_call'));
    const t0 = Date.now();
    app.ws.close();
    await until(() => results.length > 0, 2000);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(results[0]).toMatchObject({ type: 'tool_result', callId: 'mine1', ok: false, error: WINDOW_CLOSED });
    mcp.close();
  });

  it('does not let one window answer a call sent to another window', async () => {
    const a = await openApp(port, 'A', false);
    const b = await openApp(port, 'B', false); // newest window gets external calls
    const mcp = new WebSocket(`ws://127.0.0.1:${port}/chatcad-bridge?role=mcp`);
    await new Promise((r) => mcp.once('open', r));
    const results: any[] = [];
    mcp.on('message', (d) => results.push(JSON.parse(String(d))));
    mcp.send(JSON.stringify({ type: 'tool_call', callId: 'x1', name: 'get_model_state', args: {} }));
    await until(() => b.msgs.some((m) => m.type === 'tool_call'));
    const hubId = b.msgs.find((m) => m.type === 'tool_call').callId;
    expect(hubId).not.toBe('x1'); // the hub uses its own ids
    a.ws.send(JSON.stringify({ type: 'tool_result', callId: hubId, ok: true, result: 'spoofed' }));
    await wait(150);
    expect(results).toEqual([]);
    b.ws.send(JSON.stringify({ type: 'tool_result', callId: hubId, ok: true, result: 'real' }));
    await until(() => results.length > 0);
    expect(results[0]).toMatchObject({ callId: 'x1', ok: true, result: 'real' });
    a.ws.close(); b.ws.close(); mcp.close();
  });

  it("sends a chat's tool calls only to the window that started it", async () => {
    const a = await openApp(port, 'A');
    const b = await openApp(port, 'B'); // newer window
    a.ws.send(JSON.stringify({ type: 'chat', id: 'r1', text: JSON.stringify({ calls: [{ name: 'get_model_state' }] }) }));
    await until(() => a.msgs.some((m) => m.type === 'chat_done'));
    expect(a.msgs.find((m) => m.type === 'chat_done').ok).toBe(true);
    expect(a.msgs.filter((m) => m.type === 'tool_call')).toHaveLength(1);
    expect(b.msgs.filter((m) => m.type === 'tool_call')).toHaveLength(0);
    const res = a.msgs.find((m) => m.type === 'chat_event' && m.event.type === 'user');
    expect(res.event.message.content[0].content[0].text).toBe('{"window":"A"}');
    a.ws.close(); b.ws.close();
  });

  it('stops a running chat when its window closes (no usage spent on a closed window)', async () => {
    const a = await openApp(port, 'A');
    const b = await openApp(port, 'B');
    a.ws.send(JSON.stringify({ type: 'chat', id: 'r2', text: JSON.stringify({ calls: [{ name: 'get_model_state' }], hang: true }) }));
    await until(() => a.msgs.some((m) => m.type === 'chat_event' && m.event.type === 'user'));
    // Another window cannot stop it.
    b.ws.send(JSON.stringify({ type: 'stop', id: 'r2' }));
    await wait(200);
    expect(bridge.runningChats()).toBe(1);
    a.ws.close();
    await until(() => bridge.runningChats() === 0, 5000);
    b.ws.close();
  });
});

describe('chat usage guards (E5) and stopping (E4)', () => {
  const http = createServer();
  let bridge: any;
  let port = 0;
  const limits = { maxTurns: 8, maxToolCalls: 5, maxViews: 2, repeatFailures: 3 };
  beforeAll(async () => {
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
    port = (http.address() as any).port;
    bridge = attachBridge(http, { port, claudeCmd: FAKE, loggedIn: true, limits });
  });
  afterAll(() => { bridge?.close(); http.close(); });

  /** A window whose tool calls fail when fail(name, args) says so. */
  async function appFailing(fail: (name: string, args: any) => boolean | 'soft') {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/chatcad-bridge?role=app`, { headers: { origin: `http://localhost:${port}` } });
    const msgs: any[] = [];
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      msgs.push(m);
      if (m.type !== 'tool_call') return;
      const f = fail(m.name, m.args);
      // 'soft': the tool ran but reports ok:false (how most CAD tool failures come back).
      ws.send(JSON.stringify(f === 'soft' ? { type: 'tool_result', callId: m.callId, ok: true, result: { ok: false, message: 'radius too big' } }
        : f ? { type: 'tool_result', callId: m.callId, ok: false, error: 'Feature not found' }
          : { type: 'tool_result', callId: m.callId, ok: true, result: { ok: true } }));
    });
    await new Promise((r) => ws.once('open', r));
    await until(() => msgs.some((m) => m.type === 'status'));
    const chat = async (id: string, script: object) => {
      ws.send(JSON.stringify({ type: 'chat', id, text: JSON.stringify(script) }));
      await until(() => msgs.some((m) => m.type === 'chat_done' && m.id === id), 15000);
      return msgs.find((m) => m.type === 'chat_done' && m.id === id);
    };
    const toolCalls = (name?: string) => msgs.filter((m) => m.type === 'tool_call' && (!name || m.name === name));
    return { ws, msgs, chat, toolCalls };
  }

  it('starts Claude Code with a turn limit', async () => {
    const a = await appFailing(() => false);
    const done = await a.chat('t0', { calls: [] });
    expect(done.ok).toBe(true);
    const init = a.msgs.find((m) => m.type === 'chat_event' && m.event.subtype === 'init').event;
    expect(init.args[init.args.indexOf('--max-turns') + 1]).toBe('8');
    a.ws.close();
  });

  it('stops a run that repeats the same failing step (loop detection)', async () => {
    const a = await appFailing(() => true);
    const done = await a.chat('t1', { calls: [{ name: 'update_feature', args: { feature_id: 'Wing', changes: { depth: 9 } }, repeat: 50 }] });
    expect(done.ok).toBe(false);
    expect(done.limit).toBe('repeat');
    expect(done.error).toMatch(/same step failed 3 times in a row.*kept \(one undo step\)/);
    expect(a.toolCalls().length).toBe(3);
    a.ws.close();
  });

  it('also catches a step that runs but keeps reporting ok:false', async () => {
    const a = await appFailing(() => 'soft');
    const done = await a.chat('t1b', { calls: [{ name: 'fillet', args: { radius: 5 }, repeat: 20 }] });
    expect(done.limit).toBe('repeat');
    expect(a.toolCalls().length).toBe(3);
    a.ws.close();
  });

  it('lets Claude retry with different arguments after a failure', async () => {
    let n = 0;
    const a = await appFailing((name) => name === 'fillet' && ++n <= 2);
    const done = await a.chat('t2', { calls: [{ name: 'fillet', args: { radius: 0.5 } }, { name: 'fillet', args: { radius: 0.25 } }, { name: 'fillet', args: { radius: 0.1 } }] });
    expect(done.ok).toBe(true);
    a.ws.close();
  });

  it('stops a run at the tool-call limit', async () => {
    const a = await appFailing(() => false);
    const calls = Array.from({ length: 7 }, (_, i) => ({ name: 'set_parameter', args: { name: `p${i}`, value: String(i) } }));
    const done = await a.chat('t3', { calls });
    expect(done.limit).toBe('calls');
    expect(done.error).toMatch(/limit of 5 CAD tool calls/);
    expect(a.toolCalls().length).toBe(5);
    a.ws.close();
  });

  it('refuses renders past the view_model limit, and the run can still finish', async () => {
    const a = await appFailing(() => false);
    const done = await a.chat('t4', { calls: [{ name: 'view_model', args: { views: ['front'] } }, { name: 'view_model', args: { views: ['right'] } }, { name: 'view_model', args: { views: ['top'] } }, { name: 'get_model_state' }] });
    expect(done.ok).toBe(true);
    expect(a.toolCalls('view_model').length).toBe(2);
    const results = a.msgs.filter((m) => m.type === 'chat_event' && m.event.type === 'user').map((m) => m.event.message.content[0]);
    expect(results[2].is_error).toBe(true);
    expect(results[2].content[0].text).toMatch(/view_model limit reached: at most 2 renders/);
    a.ws.close();
  });

  it('says plainly when the turn limit ended a run', async () => {
    // Its own bridge with a turn limit below the tool-call limit.
    const http2 = createServer();
    await new Promise<void>((r) => http2.listen(0, '127.0.0.1', () => r()));
    const port2 = (http2.address() as any).port;
    const b2 = attachBridge(http2, { port: port2, claudeCmd: FAKE, loggedIn: true, limits: { maxTurns: 3 } });
    const ws = new WebSocket(`ws://127.0.0.1:${port2}/chatcad-bridge?role=app`, { headers: { origin: `http://localhost:${port2}` } });
    const msgs: any[] = [];
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)); msgs.push(m);
      if (m.type === 'tool_call') ws.send(JSON.stringify({ type: 'tool_result', callId: m.callId, ok: true, result: { ok: true } }));
    });
    await new Promise((r) => ws.once('open', r));
    const calls = Array.from({ length: 12 }, (_, i) => ({ name: 'get_model_state', args: { i } }));
    ws.send(JSON.stringify({ type: 'chat', id: 't5', text: JSON.stringify({ calls }) }));
    await until(() => msgs.some((m) => m.type === 'chat_done'), 15000);
    const done = msgs.find((m) => m.type === 'chat_done');
    expect(done.ok).toBe(false);
    expect(done.limit).toBe('turns');
    expect(done.error).toMatch(/limit of 3 steps for one request.*Ask again to continue/);
    expect(msgs.filter((m) => m.type === 'tool_call').length).toBe(3);
    ws.close(); b2.close(); http2.close();
  });

  it('never runs two requests at once for one window', async () => {
    const a = await appFailing(() => false);
    a.ws.send(JSON.stringify({ type: 'chat', id: 'long', text: JSON.stringify({ calls: [{ name: 'get_model_state' }], hang: true }) }));
    await until(() => a.toolCalls().length === 1);
    const second = await a.chat('second', { calls: [{ name: 'get_model_state' }] });
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/still working on the last request/);
    expect(bridge.runningChats()).toBe(1);
    // Stop ends it at once, and says the work is kept.
    a.ws.send(JSON.stringify({ type: 'stop', id: 'long' }));
    await until(() => a.msgs.some((m) => m.type === 'chat_done' && m.id === 'long'), 5000);
    const done = a.msgs.find((m) => m.type === 'chat_done' && m.id === 'long');
    expect(done.ok).toBe(false);
    expect(done.error).toMatch(/^Stopped\. Everything built so far is kept/);
    expect(bridge.runningChats()).toBe(0);
    a.ws.close();
  });
});

describe('stopping Claude Code and everything it started (E4)', () => {
  it('uses taskkill on the whole process tree on Windows', () => {
    const calls: any[] = [];
    const child = { pid: 4242, exitCode: null, signalCode: null, kill: () => calls.push('kill') };
    killTree(child, 'win32', (cmd: string, args: string[], o: any) => { calls.push({ cmd, args, o }); return { on() {} }; });
    expect(calls).toEqual([{ cmd: 'taskkill', args: ['/pid', '4242', '/T', '/F'], o: { windowsHide: true, stdio: 'ignore' } }]);
  });

  it('falls back to a plain kill if taskkill cannot start', () => {
    const calls: any[] = [];
    const child = { pid: 7, exitCode: null, signalCode: null, kill: () => calls.push('kill') };
    killTree(child, 'win32', () => ({ on: (ev: string, fn: () => void) => { if (ev === 'error') fn(); } }));
    expect(calls).toEqual(['kill']);
  });

  it('sends SIGTERM, then SIGKILL if the process is still running', async () => {
    const sig: string[] = [];
    const child: any = { pid: 9, exitCode: null, signalCode: null, kill: (s: string) => sig.push(s) };
    killTree(child, 'linux', undefined, 30);
    expect(sig).toEqual(['SIGTERM']);
    await wait(60);
    expect(sig).toEqual(['SIGTERM', 'SIGKILL']);
    const gone: any = { pid: 9, exitCode: null, signalCode: null, kill: (s: string) => { gone.signalCode = s; sig.push(`gone:${s}`); } };
    killTree(gone, 'linux', undefined, 30);
    await wait(60);
    expect(sig.slice(2)).toEqual(['gone:SIGTERM']);
    // Already finished: nothing to do.
    killTree({ pid: 1, exitCode: 0, signalCode: null, kill: () => sig.push('late') }, 'linux');
    expect(sig).not.toContain('late');
  });
});
