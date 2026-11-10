#!/usr/bin/env node
/**
 * CHAD launcher: keeps a copy of the newest CHAD from GitHub on this computer and starts it.
 *
 * CHAD is the 3D-printing edition split from the ChatCAD engineering edition. Everything here is
 * separate from ChatCAD's launcher so both can be installed and even run at the same time:
 * its own folder, Desktop icon, port (so its own browser autosave), environment variables and repository.
 *
 * Needs only Node.js (built-in fetch) and the `tar` that ships with Windows 10/11, macOS and Linux.
 * Nothing else is installed globally. Everything lives in one folder (CHAD_HOME):
 *
 *   Windows: %LOCALAPPDATA%\CHAD      elsewhere: ~/.chad
 *     launcher.mjs   this file (refreshed from the app after every update)
 *     CHAD.cmd       what the Desktop / Start menu shortcuts run (Windows)
 *     chad.ico       shortcut icon
 *     app/           the app itself; node_modules is kept across updates
 *     state.json     which version is in app/ and which packages are installed
 *     branch.txt     optional: one line naming a branch to follow instead of main
 *
 * Usage: node chad-launcher.mjs [--install] [--branch <name>] [--no-update] [--no-open]
 *   --install    also create the Desktop and Start menu shortcuts (Windows)
 *   --no-update  start the copy already on this computer without checking GitHub
 *   --no-open    do not open the browser
 *
 * The app always runs on http://localhost:5180 (fixed port, DEFAULT_PORT) because the browser keeps the
 * autosaved part per address; a different port would look like an empty app. ChatCAD uses 5173.
 * Environment overrides: CHAD_HOME, CHAD_PORT, CHAD_BRANCH, CHAD_GITHUB_TOKEN (never ChatCAD's CHATCAD_*).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { connect } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

// Keep these three in step with brand.json (tests/brand.test.ts checks it).
export const APP_NAME = 'CHAD';
export const REPO = 'zac37broncos-jpg/chat-cad-v1';
export const DEFAULT_PORT = 5180;
export const DEFAULT_BRANCH = 'main';
const UA = 'chad-launcher';

export function parseArgs(argv) {
  const o = { install: false, update: true, open: true, branch: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--install') o.install = true;
    else if (a === '--no-update') o.update = false;
    else if (a === '--no-open') o.open = false;
    else if (a === '--branch' && argv[i + 1]) o.branch = argv[++i];
  }
  return o;
}

export function homeDir(env = process.env, platform = process.platform) {
  if (env.CHAD_HOME) return env.CHAD_HOME;
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(env.USERPROFILE || homedir(), 'AppData', 'Local'), 'CHAD');
  return join(env.HOME || homedir(), '.chad');
}

/** Vite 8 needs Node ^20.19.0 || >=22.12.0. */
export function nodeVersionOk(v = process.versions.node) {
  const [maj, min] = v.split('.').map(Number);
  return (maj === 20 && min >= 19) || (maj === 22 && min >= 12) || maj > 22;
}

/** Git branch names we accept (keeps the value safe inside URLs). */
export const validBranch = (b) => typeof b === 'string' && /^[A-Za-z0-9._\/-]{1,200}$/.test(b) && !b.includes('..');

/** Find a branch's commit in git's smart-HTTP ref advertisement (`/info/refs?service=git-upload-pack`). */
export function parseInfoRefs(text, branch) {
  const want = `refs/heads/${branch}`;
  for (const line of text.split('\n')) {
    const m = /([0-9a-f]{40}) ([^\s\0]+)/.exec(line);
    if (m && m[2] === want) return m[1];
  }
  return null;
}

/** Thrown when GitHub needs a sign-in (private repo) or rejected the one we sent. */
export class AuthNeeded extends Error {}

/** HTTP headers for a GitHub credential ({username, token}); none when signed out. */
export function authHeaders(cred, kind = 'basic') {
  if (!cred?.token) return {};
  return { authorization: kind === 'bearer' ? `Bearer ${cred.token}` : `Basic ${Buffer.from(`${cred.username || 'x-access-token'}:${cred.token}`).toString('base64')}` };
}

/**
 * The newest commit on `branch`. Uses git's ref list first (no API rate limit), then the GitHub API.
 * A private repo answers 401/404 to anonymous requests: that throws AuthNeeded.
 */
export async function latestSha(branch, fetchImpl = fetch, cred = null) {
  let status = 0;
  try {
    const r = await fetchImpl(`https://github.com/${REPO}.git/info/refs?service=git-upload-pack`, { headers: { 'user-agent': UA, ...authHeaders(cred) }, signal: AbortSignal.timeout(20000) });
    status = r.status;
    if (r.ok) { const sha = parseInfoRefs(await r.text(), branch); if (sha) return sha; }
  } catch { /* try the API */ }
  const r = await fetchImpl(`https://api.github.com/repos/${REPO}/commits/${encodeURIComponent(branch)}`, {
    headers: { 'user-agent': UA, accept: 'application/vnd.github.sha', ...authHeaders(cred, 'bearer') }, signal: AbortSignal.timeout(20000),
  });
  const t = (await r.text()).trim();
  if (r.ok && /^[0-9a-f]{40}$/.test(t)) return t;
  if (status === 401 || r.status === 401 || (r.status === 404 && !cred && status !== 200)) throw new AuthNeeded(cred ? 'GitHub did not accept the sign-in' : 'GitHub sign-in needed');
  throw new Error(r.status === 404 || r.status === 422 ? `branch "${branch}" was not found on GitHub` : `GitHub answered ${r.status}`);
}

/** Where Git is: on PATH, or the default install folder (a window opened before installing Git has a stale PATH). */
export function findGit(env = process.env, platform = process.platform, exists = existsSync) {
  if (platform === 'win32') {
    for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs')]) {
      const p = base && join(base, 'Git', 'cmd', 'git.exe');
      if (p && exists(p)) return p;
    }
  }
  const r = spawnSync(platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8', windowsHide: true });
  const p = r.status === 0 ? r.stdout.split(/\r?\n/).map((x) => x.trim()).find(Boolean) : null;
  return p || null;
}

/** Parse `git credential` key=value output. */
export function parseCredential(text) {
  const o = {};
  for (const line of text.split(/\r?\n/)) { const i = line.indexOf('='); if (i > 0) o[line.slice(0, i)] = line.slice(i + 1); }
  return o.password ? { username: o.username || 'x-access-token', token: o.password } : null;
}

/**
 * Ask Git's credential helper for the github.com sign-in. On Windows that is Git Credential Manager:
 * it returns the saved sign-in, or opens the browser to sign in once and keeps it in Windows Credential Manager.
 * The token is only held in memory here; nothing is written to disk by the launcher.
 */
function gitCredential(git, action, cred) {
  const input = `protocol=https\nhost=github.com\n${cred ? `username=${cred.username}\npassword=${cred.token}\n` : ''}\n`;
  // Off Windows there is usually no browser sign-in helper; never hang on a terminal password prompt.
  const env = process.platform === 'win32' ? process.env : { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const r = spawnSync(git, ['credential', action], { input, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'], timeout: 10 * 60000, windowsHide: false });
  return action === 'fill' && r.status === 0 ? parseCredential(r.stdout) : null;
}

/** A GitHub sign-in: CHAD_GITHUB_TOKEN, else Git's credential helper. Null if neither is available. */
function getCredential(git) {
  if (process.env.CHAD_GITHUB_TOKEN) return { username: 'x-access-token', token: process.env.CHAD_GITHUB_TOKEN, fromEnv: true };
  if (!git) return null;
  say(`GitHub asked for a sign-in to download ${APP_NAME}. If a GitHub window opens, sign in and approve it.`);
  return gitCredential(git, 'fill');
}

export function depsHash(appDir) {
  const h = createHash('sha256');
  for (const f of ['package.json', 'package-lock.json']) {
    const p = join(appDir, f);
    h.update(f).update(existsSync(p) ? readFileSync(p) : Buffer.alloc(0));
  }
  return h.digest('hex');
}

/** Contents of the Windows CHAD.cmd that the shortcuts run. */
export function windowsCmd() {
  return [
    '@echo off',
    `title ${APP_NAME}`,
    'where node >nul 2>nul',
    'if errorlevel 1 (',
    `  echo Node.js is missing. Install the LTS version from https://nodejs.org, then open ${APP_NAME} again.`,
    '  pause',
    '  exit /b 1',
    ')',
    'node "%~dp0launcher.mjs" %*',
    '',
  ].join('\r\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (m = '') => console.log(m);

function readJson(p, fallback) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } }
function writeJson(p, v) { writeFileSync(p + '.tmp', JSON.stringify(v, null, 2)); renameSync(p + '.tmp', p); }

/** Rename with retries: on Windows, antivirus or an open Explorer window can lock a folder for a moment. */
async function renameRetry(a, b) {
  for (let i = 0; ; i++) {
    try { renameSync(a, b); return; } catch (e) { if (i >= 20) throw e; await sleep(500); }
  }
}
function rmQuiet(p) { try { rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* cleaned next run */ } }

async function download(url, file, cred) {
  // Fetch drops the Authorization header when GitHub redirects to its download server (which gets its own token).
  const r = await fetch(url, { headers: { 'user-agent': UA, ...authHeaders(cred, 'bearer') }, signal: AbortSignal.timeout(10 * 60000) });
  if (!r.ok || !r.body) throw new Error(`download failed (${r.status})`);
  await pipeline(Readable.fromWeb(r.body), createWriteStream(file));
}

function tarCommand(env = process.env) {
  if (process.platform === 'win32') {
    // Use Windows' own bsdtar; a GNU tar from Git would read "C:" as a remote host.
    const sys = join(env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    return existsSync(sys) ? sys : 'tar';
  }
  return 'tar';
}

/** Download `sha` and swap it into home/app, keeping node_modules. Returns false if left unchanged. */
async function updateApp(home, sha, cred) {
  const app = join(home, 'app');
  const staging = join(home, 'app-new');
  const old = join(home, 'app-old');
  const tarball = join(home, 'download.tar.gz');
  rmQuiet(staging); rmQuiet(old);
  mkdirSync(staging, { recursive: true });
  say(`Downloading the newest ${APP_NAME} (${sha.slice(0, 7)})...`);
  await download(cred ? `https://api.github.com/repos/${REPO}/tarball/${sha}` : `https://codeload.github.com/${REPO}/tar.gz/${sha}`, tarball, cred);
  // Relative paths only (cwd = home), so no tar ever sees a drive letter.
  const x = spawnSync(tarCommand(), ['-xzf', 'download.tar.gz', '-C', 'app-new', '--strip-components=1'], { cwd: home, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  rmQuiet(tarball);
  if (x.error || x.status !== 0) throw new Error(`could not unpack the download: ${x.error?.message ?? x.stderr}`);
  if (!existsSync(join(staging, 'package.json')) || !existsSync(join(staging, 'index.html'))) {
    rmQuiet(staging);
    throw new Error('the newest version on GitHub is not a runnable app yet');
  }
  const nm = join(app, 'node_modules');
  if (existsSync(nm)) await renameRetry(nm, join(staging, 'node_modules'));
  try {
    if (existsSync(app)) await renameRetry(app, old);
  } catch (e) {
    // Put the packages back so the old version still runs.
    if (existsSync(join(staging, 'node_modules'))) await renameRetry(join(staging, 'node_modules'), nm).catch(() => {});
    throw new Error(`the app folder is in use (${e.code ?? e.message}). Close any window showing it and try again`);
  }
  await renameRetry(staging, app);
  rmQuiet(old);
  return true;
}

function npmInstall(app) {
  say('Installing the app\'s building blocks (first time takes a few minutes)...');
  return new Promise((resolve) => {
    const c = spawn('npm install --no-audit --no-fund', { cwd: app, shell: true, stdio: 'inherit' });
    c.on('error', () => resolve(false));
    c.on('close', (code) => resolve(code === 0));
  });
}

/** 'chatcad' if this app (CHAD) answers on the port, 'other' if something else holds it (ChatCAD too), 'free' otherwise. */
export async function portState(port) {
  try {
    const r = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(2500) });
    if ((await r.text()).includes(`<title>${APP_NAME}</title>`)) return 'chatcad';
    return 'other';
  } catch {
    const busy = await new Promise((res) => {
      const s = connect({ port, host: 'localhost' });
      s.once('connect', () => { s.destroy(); res(true); });
      s.once('error', () => res(false));
      s.setTimeout(1500, () => { s.destroy(); res(false); });
    });
    return busy ? 'other' : 'free';
  }
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).unref(); } catch { /* user can open it */ }
}

/** Copy the launcher and icon out of the app folder so the shortcut always runs the newest launcher. */
function refreshLauncher(home) {
  const app = join(home, 'app');
  const src = join(app, 'launcher', 'chad-launcher.mjs');
  const self = fileURLToPath(import.meta.url);
  const dest = join(home, 'launcher.mjs');
  // Node has already read this file, so replacing it while it runs is safe.
  if (existsSync(src)) copyFileSync(src, dest);
  else if (self !== dest) copyFileSync(self, dest);
  const ico = join(app, 'launcher', 'chad.ico');
  if (existsSync(ico)) copyFileSync(ico, join(home, 'chad.ico'));
  if (process.platform === 'win32') writeFileSync(join(home, 'CHAD.cmd'), windowsCmd());
}

/** Desktop + Start menu shortcuts (Windows). Uses the real Desktop folder, even when OneDrive moved it. */
function createShortcuts(home) {
  if (process.platform !== 'win32') { say(`Shortcuts are Windows-only. Start ${APP_NAME} with: node "${join(home, 'launcher.mjs')}"`); return; }
  const lit = (s) => `'${s.replace(/'/g, "''")}'`;
  const ps = [
    '$ws = New-Object -ComObject WScript.Shell',
    "foreach ($d in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {",
    '  if (-not $d) { continue }',
    `  $s = $ws.CreateShortcut((Join-Path $d '${APP_NAME}.lnk'))`,
    `  $s.TargetPath = ${lit(join(home, 'CHAD.cmd'))}`,
    `  $s.WorkingDirectory = ${lit(home)}`,
    `  $s.IconLocation = ${lit(join(home, 'chad.ico') + ',0')}`,
    `  $s.Description = 'Open the newest ${APP_NAME}'`,
    '  $s.Save()',
    '  Write-Output $s.FullName',
    '}',
  ].join('\n');
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true });
  if (r.status === 0) for (const l of r.stdout.split(/\r?\n/).filter(Boolean)) say(`Shortcut created: ${l}`);
  else say(`Could not create the shortcuts (${(r.stderr || r.error?.message || '').trim().split('\n')[0]}). You can still start ${APP_NAME} by double-clicking ${join(home, 'CHAD.cmd')}`);
}

async function waitForEnter(msg) {
  say(msg);
  if (!process.stdin.isTTY) return;
  const rl = createInterface({ input: process.stdin });
  await new Promise((r) => rl.once('line', r));
  rl.close();
}

async function fail(msg) {
  say();
  say(`${APP_NAME} could not start: ${msg}`);
  await waitForEnter('If this keeps happening, open an issue on the GitHub page with a screenshot of this window. Press Enter to close.');
  process.exit(1);
}

/**
 * Newest commit on `branch`, signing in to GitHub when the repo is private.
 * Remembers in `state.private` that a sign-in is needed so later starts skip the anonymous try.
 */
export async function checkGitHub(branch, state, deps = {}) {
  const { fetchImpl = fetch, git = findGit(), credential = (action, c) => (action === 'fill' ? getCredential(git) : git && !c?.fromEnv ? gitCredential(git, action, c) : null) } = deps;
  let cred = state.private ? credential('fill') : null;
  let sha;
  try {
    sha = await latestSha(branch, fetchImpl, cred);
  } catch (e) {
    if (!(e instanceof AuthNeeded)) throw e;
    if (cred) credential('reject', cred); // the saved sign-in stopped working: forget it and ask once more
    cred = credential('fill');
    if (!cred) throw new AuthNeeded(git ? `the GitHub sign-in did not finish. Open ${APP_NAME} again and approve the GitHub window` : `GitHub asked for a sign-in, and signing in to GitHub needs Git. Follow the one-time setup steps in the README`);
    sha = await latestSha(branch, fetchImpl, cred);
    state.private = true;
  }
  if (cred) credential('approve', cred); // keep the working sign-in for next time
  return { sha, cred };
}

export async function main(argv = process.argv.slice(2)) {
  const opt = parseArgs(argv);
  const home = homeDir();
  const app = join(home, 'app');
  const port = Number(process.env.CHAD_PORT) || DEFAULT_PORT;
  const url = `http://localhost:${port}`;
  mkdirSync(home, { recursive: true });
  say(`${APP_NAME} launcher`);
  say('='.repeat(APP_NAME.length + 9));
  if (!nodeVersionOk()) return fail(`Node.js ${process.versions.node} is too old. Install the LTS version from https://nodejs.org, then try again.`);

  const statePath = join(home, 'state.json');
  const state = readJson(statePath, {});
  const branchFile = readFileSyncSafe(join(home, 'branch.txt')).trim();
  const branch = opt.branch || process.env.CHAD_BRANCH || branchFile || DEFAULT_BRANCH;
  if (!validBranch(branch)) return fail(`"${branch}" is not a valid branch name.`);

  const running = await portState(port);
  if (running === 'chatcad') {
    if (opt.install) { refreshLauncher(home); createShortcuts(home); }
    say(`${APP_NAME} is already running in another window, so this opens it in your browser.`);
    say(`To get the newest version, close the other black ${APP_NAME} window and open ${APP_NAME} again.`);
    if (opt.open) openBrowser(url);
    await sleep(4000);
    return;
  }
  if (running === 'other') return fail(`another program is using ${url}. Restart the computer, then open ${APP_NAME} again.`);

  const haveApp = existsSync(join(app, 'package.json'));
  if (opt.update || !haveApp) {
    say(`Checking GitHub for the newest version (${branch})...`);
    let sha = null, cred = null;
    try {
      ({ sha, cred } = await checkGitHub(branch, state));
      writeJson(statePath, state);
    } catch (e) {
      const why = e instanceof AuthNeeded ? e.message : `could not reach GitHub (${e.message}). Check the internet connection`;
      if (!haveApp) return fail(`${why}.`);
      say(`Could not check for updates: ${why}. Opening the version already on this computer.`);
    }
    if (sha && (sha !== state.sha || state.branch !== branch || !haveApp)) {
      try {
        await updateApp(home, sha, cred);
        Object.assign(state, { sha, branch, updatedAt: new Date().toISOString() });
        writeJson(statePath, state);
        say('Updated.');
      } catch (e) {
        if (!existsSync(join(app, 'package.json'))) return fail(e.message);
        say(`Update skipped: ${e.message}. Opening the version already on this computer.`);
      }
    } else if (sha) say('You already have the newest version.');
  }

  const hash = depsHash(app);
  if (!existsSync(join(app, 'node_modules')) || state.depsHash !== hash) {
    if (!(await npmInstall(app))) return fail('installing the building blocks failed (see the messages above). Check the internet connection and try again.');
    state.depsHash = hash;
    writeJson(statePath, state);
  }

  try { refreshLauncher(home); } catch (e) { say(`(Could not refresh the launcher: ${e.message})`); }
  if (opt.install) createShortcuts(home);

  say();
  say(`Starting ${APP_NAME} at ${url}${state.sha ? ` (version ${state.sha.slice(0, 7)})` : ''}.`);
  say(`Keep this window open while you work. Close it to stop ${APP_NAME}.`);
  say();
  process.on('SIGINT', () => {}); // let the app shut down first on Ctrl+C
  const child = spawn(`npm run dev -- --port ${port} --strictPort${opt.open ? ' --open' : ''}`, { cwd: app, shell: true, stdio: 'inherit' });
  const code = await new Promise((r) => { child.on('error', () => r(1)); child.on('close', (c) => r(c ?? 0)); });
  if (code !== 0) await fail(`the app stopped with an error (code ${code}).`);
}

function readFileSyncSafe(p) { try { return readFileSync(p, 'utf8'); } catch { return ''; } }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => fail(e?.message ?? String(e)));
}
