import { describe, it, expect, afterAll } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
// @ts-expect-error plain JS module
import { attachBridge, claudeLoggedIn, openLoginWindow, NEEDS_LOGIN } from '../bridge/hub.mjs';

/** A stand-in for a signed-out Claude Code. */
function fakeSignedOutClaude(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-claude-'));
  const p = join(dir, 'claude');
  writeFileSync(p, `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('2.0.0 (Claude Code)'); process.exit(0); }
if (a[0] === 'auth' && a[1] === 'status') { console.log(JSON.stringify({ loggedIn: false })); process.exit(1); }
process.stdin.resume(); process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login', session_id: 's1' }) + '\\n', () => process.exit(1));
});
`);
  chmodSync(p, 0o755);
  return p;
}

describe('Claude sign-in detection', () => {
  const http = createServer();
  let bridge: any;
  afterAll(() => { bridge?.close(); http.close(); });

  it('recognises Claude Code sign-in messages', () => {
    expect(NEEDS_LOGIN.test('Not logged in · Please run /login')).toBe(true);
    expect(NEEDS_LOGIN.test('Invalid API key · Please run /login')).toBe(true);
    expect(NEEDS_LOGIN.test('Made a 4 x 2 plate')).toBe(false);
  });

  it('reads `claude auth status --json`, including the non-zero exit when signed out', () => {
    expect(claudeLoggedIn({ path: fakeSignedOutClaude(), shell: false })).toBe(false);
    expect(claudeLoggedIn({ path: 'x', shell: false }, () => '{"loggedIn":true}')).toBe(true);
    expect(claudeLoggedIn({ path: 'x', shell: false }, () => { throw new Error('unknown command'); })).toBe(null);
    expect(claudeLoggedIn(null)).toBe(null);
  });

  it('opens a visible sign-in window with the full path on Windows (PATH may be stale)', () => {
    const calls: any[] = [];
    const ok = openLoginWindow({ path: 'C:\\Users\\Example\\.local\\bin\\claude.exe', shell: false }, 'win32', (c: string, a: string[], o: any) => { calls.push({ c, a, o }); return { unref() {} }; });
    expect(ok).toBe(true);
    expect(calls[0].a[0]).toBe('/d /c start "Sign in to Claude" cmd /k ""C:\\Users\\Example\\.local\\bin\\claude.exe" auth login"');
    expect(calls[0].o).toMatchObject({ windowsVerbatimArguments: true, detached: true });
  });

  it('reports signed-out status to the app, also when a chat run hits /login', async () => {
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
    const port = (http.address() as any).port;
    const fake = fakeSignedOutClaude();
    process.env.CHATCAD_CLAUDE_PATH = fake; // Re-check resolves Claude Code again
    bridge = attachBridge(http, { port, claudeCmd: { path: fake, shell: false }, loggedIn: true });
    const app = new WebSocket(`ws://127.0.0.1:${port}/chatcad-bridge?role=app`);
    const msgs: any[] = [];
    app.on('message', (d) => msgs.push(JSON.parse(String(d))));
    await new Promise((r) => app.once('open', r));
    await new Promise((r) => setTimeout(r, 100));
    expect(msgs.find((m) => m.type === 'status').claude.loggedIn).toBe(true);
    app.send(JSON.stringify({ type: 'chat', id: 'c1', text: 'hi' }));
    for (let i = 0; i < 100 && !msgs.some((m) => m.type === 'chat_done'); i++) await new Promise((r) => setTimeout(r, 50));
    const last = msgs.filter((m) => m.type === 'status').at(-1);
    expect(last.claude.loggedIn).toBe(false);
    app.send(JSON.stringify({ type: 'recheck' }));
    for (let i = 0; i < 100 && msgs.filter((m) => m.type === 'status').length < 3; i++) await new Promise((r) => setTimeout(r, 50));
    expect(msgs.filter((m) => m.type === 'status').at(-1).claude.loggedIn).toBe(false);
    app.close();
    delete process.env.CHATCAD_CLAUDE_PATH;
  });
});
