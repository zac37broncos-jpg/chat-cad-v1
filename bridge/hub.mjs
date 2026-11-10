/**
 * CHAD bridge hub. Runs inside the Vite dev server (see vite.config.ts),
 * so `npm run dev` starts everything.
 *
 *   CHAD window     <--ws role=app-->  hub  <--ws role=mcp--  mcp-server.mjs  <--stdio--  Claude
 *                                       |
 *                                       +-- spawns headless Claude Code (`claude -p`) for in-app chat,
 *                                           which uses the user's Claude subscription login.
 *
 * Security:
 *  - Only loopback connections are accepted.
 *  - role=app must come from this server's own page (Origin http://localhost:<this port>),
 *    so another web page or another local dev server cannot pose as the CHAD window.
 *  - role=mcp is for local Node programs (mcp-server.mjs). Browsers always send an Origin
 *    header on WebSocket connections and Node clients do not, so an MCP connection with
 *    an Origin header is a web page trying to drive the model, and is refused.
 *  - Each in-app chat run gets its own secret token; its tool calls go only to the window
 *    that started it. Tool calls without a run token (Claude desktop) go to the newest window.
 */
import { WebSocketServer } from 'ws';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
/** Product name shown in messages (brand.json, the one place the name lives). */
const APP_NAME = JSON.parse(readFileSync(join(here, '..', 'brand.json'), 'utf8')).name;
export const BRIDGE_PATH = '/chatcad-bridge';

const isLoopback = (addr) => !!addr && (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1');

/**
 * May a WebSocket upgrade with this role and Origin header connect? (item B4)
 * app: no Origin (a local program) or exactly this server's own page on loopback.
 * mcp: never with an Origin (browsers always send one, Node MCP clients never do).
 */
export function upgradeAllowed(role, origin, port) {
  if (role === 'mcp') return origin === undefined;
  if (role !== 'app') return false;
  if (origin === undefined) return true;
  const m = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):(\d+)$/.exec(String(origin));
  return !!m && Number(m[2]) === Number(port);
}

/**
 * Usage guards for one chat request. One request can never
 * run away and spend a big share of the Claude plan:
 *  - maxTurns: passed to Claude Code as --max-turns (counts tool-use round trips; Claude Code
 *    ends the run with result subtype "error_max_turns"). A whole figurine build takes ~20-40.
 *  - maxToolCalls: CAD tool calls per request (build_model counts once, however many steps).
 *  - maxViews: view_model renders per request (images are the most expensive input). Further
 *    renders are refused with a message so Claude can still finish its answer.
 *  - repeatFailures: the same tool with the same arguments failing this many times in a row
 *    stops the run (a bug that fails the same way every time).
 * When a guard stops a run, everything built so far stays and is one undo step (the window
 * squashes the request when it ends), and the chat says which limit stopped it.
 */
export const LIMITS = Object.freeze({ maxTurns: 60, maxToolCalls: 150, maxViews: 6, repeatFailures: 3 });

/** Plain words for the chat when a guard stops a request. */
export const limitMessage = (which, limits = LIMITS) => {
  const kept = 'Everything built so far is kept (one undo step). Ask again to continue.';
  switch (which) {
    case 'turns': return `Stopped at the safety limit of ${limits.maxTurns} steps for one request, so a single request cannot use up your Claude plan. ${kept}`;
    case 'calls': return `Stopped at the safety limit of ${limits.maxToolCalls} CAD tool calls for one request, so a single request cannot use up your Claude plan. ${kept}`;
    case 'repeat': return `Stopped because the same step failed ${limits.repeatFailures} times in a row (it would keep failing and use up your Claude plan). ${kept}`;
    case 'stopped': return 'Stopped. Everything built so far is kept (one undo step).';
    default: return `Stopped. ${kept}`;
  }
};
export const viewLimitError = (limits = LIMITS) => `view_model limit reached: at most ${limits.maxViews} renders per request (renders use the most of the user's Claude plan). Do not call view_model again in this request. Finish with what you have, and tell the user they can ask for another look.`;

/**
 * Stop a Claude Code run and everything it started (item E4). On Windows, child.kill() ends only
 * the process itself (with the npm .cmd shim, only the shell), so the whole tree is ended with
 * taskkill /T /F. Elsewhere SIGTERM, then SIGKILL if it is still running after graceMs.
 */
export function killTree(child, platform = process.platform, spawnFn = spawn, graceMs = 3000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (platform === 'win32' && child.pid) {
    try {
      const k = spawnFn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      k.on?.('error', () => { try { child.kill(); } catch { /* already gone */ } });
    } catch { try { child.kill(); } catch { /* already gone */ } }
    return;
  }
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
  const t = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) { try { child.kill('SIGKILL'); } catch { /* gone */ } } }, graceMs);
  t.unref?.();
}

/** Message for tool calls that can no longer be answered because the window went away. */
export const WINDOW_CLOSED = `The ${APP_NAME} window was closed, so this step was not done. Reopen ${APP_NAME} and ask again.`;

/**
 * Find the Claude Code executable. Prefers a real .exe on Windows so no shell is needed.
 * Also checks the native installer's default location, because a terminal opened before
 * installing will not have the new PATH entry.
 */
export function resolveClaude(env = process.env, platform = process.platform, exists = existsSync) {
  if (env.CHATCAD_CLAUDE_PATH) return { path: env.CHATCAD_CLAUDE_PATH, shell: false };
  const home = env.USERPROFILE || env.HOME || '';
  const fromPath = (cmd, args) => {
    try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/).map((x) => x.trim()).filter(Boolean); } catch { return []; }
  };
  if (platform === 'win32') {
    const found = fromPath('where', ['claude']);
    const exe = found.find((p) => p.toLowerCase().endsWith('.exe'));
    if (exe) return { path: exe, shell: false };
    const native = join(home, '.local', 'bin', 'claude.exe');
    if (home && exists(native)) return { path: native, shell: false };
    const cmd = found.find((p) => p.toLowerCase().endsWith('.cmd'));
    if (cmd) {
      // npm shim -> the real binary inside the package
      const real = join(dirname(cmd), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      if (exists(real)) return { path: real, shell: false };
      return { path: cmd, shell: true };
    }
    return null;
  }
  const p = fromPath('which', ['claude'])[0];
  if (p) return { path: p, shell: false };
  const native = join(home, '.local', 'bin', 'claude');
  return home && exists(native) ? { path: native, shell: false } : null;
}

function claudeVersion(c) {
  try { return execFileSync(c.path, ['--version'], { encoding: 'utf8', shell: c.shell, timeout: 15000 }).trim(); } catch { return null; }
}

/**
 * Is Claude Code signed in? true / false, or null when unknown (older versions without `claude auth`).
 * Uses the documented `claude auth status --json` output ({"loggedIn": boolean, ...}).
 */
export function claudeLoggedIn(c, run = execFileSync) {
  if (!c) return null;
  try {
    const out = run(c.path, ['auth', 'status', '--json'], { encoding: 'utf8', shell: c.shell, timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const j = JSON.parse(String(out));
    return typeof j.loggedIn === 'boolean' ? j.loggedIn : null;
  } catch (e) {
    // `auth status` exits non-zero when signed out but still prints the JSON.
    try { const j = JSON.parse(String(e.stdout ?? '')); return typeof j.loggedIn === 'boolean' ? j.loggedIn : null; } catch { return null; }
  }
}

/** Text Claude Code prints when it needs a sign-in (e.g. "Not logged in · Please run /login", "Invalid API key · Please run /login"). */
export const NEEDS_LOGIN = /please run \/login|not logged in|invalid api key|oauth token (has )?expired|token has been revoked|authentication_error/i;

/**
 * Open a visible window that runs `claude auth login` (it opens the browser to sign in).
 * Returns false when no terminal could be opened on this system.
 */
export function openLoginWindow(c, platform = process.platform, spawnFn = spawn, has = (cmd) => { try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; } }) {
  if (!c) return false;
  const opts = { detached: true, stdio: 'ignore', windowsHide: false };
  // A failed launch reports asynchronously; never let it crash the dev server.
  const launch = (cmd, args, extra = {}) => { const ch = spawnFn(cmd, args, { ...opts, ...extra }); ch.on?.('error', () => {}); ch.unref?.(); };
  try {
    if (platform === 'win32') {
      // cmd /k ""C:\path\claude.exe" auth login": cmd strips the outer quotes and keeps the quoted path.
      launch(process.env.ComSpec || 'cmd.exe', [`/d /c start "Sign in to Claude" cmd /k ""${c.path}" auth login"`], { windowsVerbatimArguments: true });
      return true;
    }
    if (platform === 'darwin') {
      const cmd = `'${c.path.replace(/'/g, "'\\''")}' auth login`;
      launch('osascript', ['-e', `tell application "Terminal" to do script "${cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`, '-e', 'tell application "Terminal" to activate']);
      return true;
    }
    if (!has('x-terminal-emulator')) return false;
    launch('x-terminal-emulator', ['-e', c.path, 'auth', 'login']);
    return true;
  } catch { return false; }
}

/** Quote an argument for cmd.exe (only used for the npm .cmd shim fallback). Empty args must survive. */
const q = (s) => (s === '' ? '""' : /[\s"&|<>^]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/**
 * @param {import('http').Server} httpServer
 * @param {{ port: number, log?: (m: string) => void, claudeCmd?: {path: string, shell: boolean} | null, model?: string, loggedIn?: boolean | null }} opts
 */
export function attachBridge(httpServer, opts) {
  const log = opts.log ?? (() => {});
  const limits = { ...LIMITS, ...(opts.limits ?? {}) };
  const kill = opts.killTree ?? killTree;
  const token = randomBytes(16).toString('hex');
  const wss = new WebSocketServer({ noServer: true });
  const apps = new Set();
  const mcps = new Set();
  /** Hub call id -> { mcp, app, callId (the MCP server's own id) }. */
  const calls = new Map();
  let callSeq = 0;
  /** Chat id -> { child, app, token, configPath }. */
  const runs = new Map();
  /** Run token -> run (so a run's MCP server is tied to the window that started the run). */
  const runByToken = new Map();
  let claude = opts.claudeCmd === undefined ? resolveClaude() : opts.claudeCmd;
  let version = claude ? claudeVersion(claude) : null;
  let loggedIn = opts.loggedIn !== undefined ? opts.loggedIn : claudeLoggedIn(claude);
  let loginPoll = null;

  // Config files for the headless Claude runs. Each run gets its own MCP config with its own
  // token, so its tool calls reach only the window that started it.
  const dir = mkdtempSync(join(tmpdir(), 'chatcad-'));
  const writeMcpConfig = (file, runToken) => {
    const path = join(dir, file);
    writeFileSync(path, JSON.stringify({
      mcpServers: {
        chatcad: {
          command: process.execPath,
          args: [join(here, 'mcp-server.mjs')],
          env: { CHATCAD_URL: `ws://localhost:${opts.port}${BRIDGE_PATH}`, CHATCAD_TOKEN: runToken },
          // A whole-model build_model call (with its exact checks) can take minutes; the default is 60 s.
          timeout: 900000,
        },
      },
    }, null, 2));
    return path;
  };
  const mcpConfigPath = writeMcpConfig('mcp.json', token);
  const promptPath = join(here, 'system-prompt.md');

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== BRIDGE_PATH) return; // leave other upgrades (Vite HMR) alone
    if (!isLoopback(req.socket.remoteAddress)) { socket.destroy(); return; }
    const role = url.searchParams.get('role');
    if (!upgradeAllowed(role, req.headers.origin, opts.port)) {
      log(`refused a bridge connection (role ${role ?? 'none'}, origin ${req.headers.origin ?? 'none'})`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => (role === 'app' ? onApp(ws) : onMcp(ws, url.searchParams.get('token') ?? '')));
  });

  const send = (ws, m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
  const latestApp = () => [...apps].at(-1);
  const status = () => ({ type: 'status', claude: { found: !!claude, path: claude?.path ?? null, version, loggedIn }, mcpConnected: mcps.size > 0 });

  /** After opening the sign-in window, check every few seconds (up to 15 min) and tell the app when it worked. */
  function watchLogin() {
    if (loginPoll) clearInterval(loginPoll);
    const until = Date.now() + 15 * 60 * 1000;
    loginPoll = setInterval(() => {
      const now = claudeLoggedIn(claude);
      if (now === true || Date.now() > until) {
        clearInterval(loginPoll); loginPoll = null;
        if (now === true) { loggedIn = true; log('Claude Code sign-in detected'); broadcastStatus(); }
      }
    }, 3000);
  }
  const markSignedOut = () => { if (loggedIn !== false) { loggedIn = false; broadcastStatus(); } };
  const broadcastStatus = () => { for (const a of apps) send(a, status()); };

  /** Answer a pending tool call with an error and forget it. */
  const failCall = (hubId, error) => {
    const c = calls.get(hubId);
    if (!c) return;
    calls.delete(hubId);
    send(c.mcp, { type: 'tool_result', callId: c.callId, ok: false, error });
  };

  /** Stop a run for a reason (Stop button, a usage guard, window closed). Its later tool calls are refused at once. */
  const stopRun = (run, reason) => {
    if (run.stopping) return;
    run.stopping = true;
    run.stopReason = reason;
    kill(run.child);
  };

  function onApp(ws) {
    apps.add(ws);
    send(ws, status());
    ws.on('close', () => {
      apps.delete(ws);
      // Nobody can answer this window's tool calls any more: fail them now instead of
      // letting Claude wait out the full timeout (finding 21).
      for (const [hubId, c] of [...calls]) if (c.app === ws) failCall(hubId, WINDOW_CLOSED);
      // A chat whose window is gone cannot be seen or undone, and would only spend usage.
      for (const [id, r] of runs) if (r.app === ws) { log(`chat ${id} stopped: its window closed`); stopRun(r, 'window'); }
    });
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.type === 'tool_result') {
        const c = calls.get(m.callId);
        if (!c || c.app !== ws) return; // only the window the call went to may answer it
        calls.delete(m.callId);
        send(c.mcp, { ...m, callId: c.callId });
        if (c.run) noteResult(c.run, c.key, m);
      } else if (m.type === 'chat') startRun(ws, m);
      else if (m.type === 'stop') { const r = runs.get(String(m.id)); if (r && r.app === ws) { stopRun(r, 'stopped'); log(`chat ${m.id} stopped by user`); } }
      else if (m.type === 'recheck') { claude = resolveClaude(); version = claude ? claudeVersion(claude) : null; loggedIn = claudeLoggedIn(claude); send(ws, status()); }
      else if (m.type === 'login') {
        const ok = openLoginWindow(claude);
        log(ok ? 'opened the Claude sign-in window' : 'could not open a sign-in window');
        send(ws, { type: 'login_started', ok, command: claude ? `"${claude.path}" auth login` : null });
        if (ok) watchLogin();
      }
    });
  }

  function onMcp(ws, presentedToken) {
    // MCP clients without a run token are allowed from loopback so the Claude desktop app
    // can connect too; their calls go to the newest open window.
    const run = runByToken.get(presentedToken) ?? null;
    mcps.add(ws);
    log(`MCP client connected${run ? ' (in-app chat)' : ' (external, e.g. Claude desktop)'}`);
    broadcastStatus();
    ws.on('close', () => {
      mcps.delete(ws);
      for (const [hubId, c] of [...calls]) if (c.mcp === ws) calls.delete(hubId);
      broadcastStatus();
    });
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.type !== 'tool_call') return;
      const refuse = (error) => send(ws, { type: 'tool_result', callId: m.callId, ok: false, error });
      const app = run ? (apps.has(run.app) ? run.app : null) : latestApp();
      if (!app) { refuse(run ? WINDOW_CLOSED : `No ${APP_NAME} window is open`); return; }
      let key = null;
      if (run) {
        // Usage guards (E5) for in-app chat runs.
        if (run.stopping) { refuse('This request was stopped.'); return; }
        run.toolCalls++;
        if (run.toolCalls > limits.maxToolCalls) { refuse(limitMessage('calls', limits)); stopRun(run, 'calls'); return; }
        try { key = `${m.name} ${JSON.stringify(m.args ?? {})}`; } catch { key = String(m.name); }
        if (m.name === 'view_model' && ++run.views > limits.maxViews) { refuse(viewLimitError(limits)); noteResult(run, key, { ok: false }); return; }
      }
      // The hub's own call id, so two MCP servers can never answer each other's calls.
      const hubId = `h${++callSeq}`;
      calls.set(hubId, { mcp: ws, app, callId: m.callId, run, key });
      send(app, { ...m, callId: hubId });
    });
  }

  /** Loop detection (E5): the same call failing again and again stops the run. */
  function noteResult(run, key, m) {
    const failed = m.ok === false || (m.result && typeof m.result === 'object' && m.result.ok === false);
    if (!failed) { run.lastFailKey = null; run.failStreak = 0; return; }
    run.failStreak = run.lastFailKey === key ? run.failStreak + 1 : 1;
    run.lastFailKey = key;
    if (run.failStreak >= limits.repeatFailures) stopRun(run, 'repeat');
  }

  function startRun(app, m) {
    const id = String(m.id);
    if (!claude) {
      send(app, { type: 'chat_done', id, ok: false, error: 'Claude Code was not found on this computer. See the setup steps in the chat panel (or README), then press Re-check.' });
      return;
    }
    if (runs.has(id)) { send(app, { type: 'chat_done', id, ok: false, error: 'This chat request is already running.' }); return; }
    // One request at a time per window: a second one (a bug, or a double send) is never started.
    if ([...runs.values()].some((r) => r.app === app)) { send(app, { type: 'chat_done', id, ok: false, error: 'Claude is still working on the last request. Wait for it to finish, or press Stop.' }); return; }
    const runToken = randomBytes(16).toString('hex');
    const configPath = writeMcpConfig(`mcp-${runToken.slice(0, 12)}.json`, runToken);
    const args = [
      '-p', '--output-format', 'stream-json', '--verbose',
      '--mcp-config', configPath, '--strict-mcp-config',
      // Usage guard (E5): Claude Code ends the run after this many tool-use turns.
      '--max-turns', String(limits.maxTurns),
      // Only the CAD tools, plus read-only web research for references ("make an Easter Island head").
      '--tools', 'WebSearch,WebFetch',
      '--allowedTools', 'mcp__chatcad,WebSearch,WebFetch',
      '--append-system-prompt-file', promptPath,
      ...(opts.model ? ['--model', opts.model] : []),
      ...(m.sessionId && /^[A-Za-z0-9-]+$/.test(m.sessionId) ? ['--resume', m.sessionId] : []),
    ];
    // Claude Code gives MCP tool calls 60 s by default; a whole-model build_model stage can take longer.
    const env = { ...process.env, MCP_TOOL_TIMEOUT: process.env.MCP_TOOL_TIMEOUT || '900000' };
    const child = spawn(claude.path, claude.shell ? args.map(q) : args, { shell: claude.shell, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
    const run = { child, app, token: runToken, configPath, toolCalls: 0, views: 0, failStreak: 0, lastFailKey: null, stopping: false, stopReason: null };
    runs.set(id, run);
    runByToken.set(runToken, run);
    let ended = false;
    const endRun = () => {
      if (ended) return false;
      ended = true;
      if (runs.get(id) === run) runs.delete(id);
      runByToken.delete(runToken);
      try { rmSync(configPath, { force: true }); } catch { /* temp file; the folder is removed on close */ }
      return true;
    };
    log(`chat ${id} started`);
    let buf = '';
    let stderr = '';
    let sessionId = m.sessionId ?? null;
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.session_id) sessionId = ev.session_id;
        if (ev.type === 'result' && ev.is_error && NEEDS_LOGIN.test(String(ev.result ?? ''))) markSignedOut();
        if (ev.type === 'result' && ev.subtype === 'error_max_turns' && !run.stopReason) run.stopReason = 'turns';
        send(app, { type: 'chat_event', id, event: ev });
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); if (stderr.length > 8000) stderr = stderr.slice(-8000); });
    child.on('error', (e) => { if (endRun()) send(app, { type: 'chat_done', id, ok: false, error: `Could not start Claude Code: ${e.message}` }); });
    child.on('close', (code, signal) => {
      if (!endRun()) return;
      log(`chat ${id} finished (code ${code}${signal ? `, ${signal}` : ''})`);
      if (code !== 0 && NEEDS_LOGIN.test(stderr)) markSignedOut();
      const failed = code !== 0 || !!run.stopReason;
      const error = run.stopReason ? limitMessage(run.stopReason, limits) : signal ? 'Stopped' : (stderr.trim().split('\n').slice(-3).join('\n') || `Claude Code exited with code ${code}`);
      if (run.stopReason) log(`chat ${id} stopped: ${run.stopReason}`);
      send(app, { type: 'chat_done', id, ok: !failed, sessionId, ...(failed ? { error, ...(run.stopReason ? { limit: run.stopReason } : {}) } : {}) });
    });
    // A run killed early (Stop, window closed) must not crash the server with EPIPE.
    child.stdin.on('error', () => {});
    child.stdin.end(String(m.text ?? ''));
  }

  return {
    token, mcpConfigPath,
    /** How many Claude Code runs are alive (for tests). */
    runningChats: () => runs.size,
    close() {
      for (const r of runs.values()) stopRun(r, 'stopped');
      if (loginPoll) clearInterval(loginPoll);
      wss.close();
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp folder */ }
    },
  };
}
