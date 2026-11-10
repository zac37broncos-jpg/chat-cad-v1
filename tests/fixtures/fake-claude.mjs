#!/usr/bin/env node
/**
 * A stand-in for Claude Code in bridge tests. It never contacts Anthropic and costs no usage.
 *
 * It reads the --mcp-config file the hub wrote, connects to the hub the way the CHAD MCP
 * server does (role=mcp + that run's token), and follows a script given as the prompt (JSON
 * on stdin): { calls: [{ name, args, repeat? }], hang?: boolean }. It keeps calling even when
 * calls fail (like a confused model would), and honours --max-turns the way Claude Code does
 * (one tool call = one turn here; past the limit: result "error_max_turns", exit code 1). It prints stream-json events like
 * Claude Code: an init event, an assistant tool_use and a user tool_result per call, a result.
 * Every argument it was started with is printed in the init event (args), so tests can check flags.
 */
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';

const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('9.9.9 (Claude Code, fake)'); process.exit(0); }
if (argv[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }

const out = (ev) => process.stdout.write(`${JSON.stringify(ev)}\n`);
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', async () => {
  const script = JSON.parse(input || '{}');
  const cfg = JSON.parse(readFileSync(argv[argv.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.chatcad.env;
  out({ type: 'system', subtype: 'init', session_id: 'fake-session', args: argv, mcp_servers: [{ name: 'chatcad', status: 'connected' }] });
  const ws = new WebSocket(`${cfg.CHATCAD_URL.replace('localhost', '127.0.0.1')}?role=mcp&token=${cfg.CHATCAD_TOKEN}`);
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  const pending = new Map();
  ws.on('message', (raw) => { const m = JSON.parse(String(raw)); pending.get(m.callId)?.(m); });
  let n = 0;
  const maxTurns = argv.includes('--max-turns') ? Number(argv[argv.indexOf('--max-turns') + 1]) : Infinity;
  const steps = (script.calls ?? []).flatMap((c) => Array.from({ length: c.repeat ?? 1 }, () => c));
  for (const c of steps) {
    if (n >= maxTurns) {
      out({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: n, session_id: 'fake-session' });
      process.exit(1);
    }
    const callId = `fake${++n}`;
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `tu${n}`, name: `mcp__chatcad__${c.name}`, input: c.args ?? {} }] } });
    const res = await new Promise((r) => { pending.set(callId, r); ws.send(JSON.stringify({ type: 'tool_call', callId, name: c.name, args: c.args ?? {} })); });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `tu${n}`, is_error: !res.ok, content: [{ type: 'text', text: res.ok ? JSON.stringify(res.result) : `Error: ${res.error}` }] }] } });
  }
  if (script.hang) return; // keep running until killed
  out({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'fake-session' });
  ws.close();
  process.exit(0);
});
