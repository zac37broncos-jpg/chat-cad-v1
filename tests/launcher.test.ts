import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
// @ts-expect-error plain JS module
import { parseArgs, homeDir, nodeVersionOk, validBranch, parseInfoRefs, latestSha, windowsCmd, portState, checkGitHub, parseCredential, authHeaders, findGit } from '../launcher/chad-launcher.mjs';

describe('one-click launcher', () => {
  it('reads its options', () => {
    expect(parseArgs([])).toEqual({ install: false, update: true, open: true, branch: null });
    expect(parseArgs(['--install', '--no-open', '--branch', 'drawings'])).toEqual({ install: true, update: true, open: false, branch: 'drawings' });
    expect(parseArgs(['--no-update']).update).toBe(false);
  });

  it('installs into LocalAppData\\CHAD on Windows and ~/.chad elsewhere, never into ChatCAD\'s folder', () => {
    expect(homeDir({ LOCALAPPDATA: 'C:\\Users\\Example\\AppData\\Local' }, 'win32')).toMatch(/AppData[\\/]Local[\\/]CHAD$/);
    expect(homeDir({ HOME: '/home/example' }, 'linux')).toMatch(/[\\/]home[\\/]example[\\/]\.chad$/);
    expect(homeDir({ CHAD_HOME: '/x' }, 'win32')).toBe('/x');
    // ChatCAD's own override must not move CHAD into ChatCAD's folder.
    expect(homeDir({ CHATCAD_HOME: '/chatcad', LOCALAPPDATA: 'C:\\L' }, 'win32')).toMatch(/[\\/]CHAD$/);
  });

  it('checks the Node.js version Vite needs', () => {
    expect(nodeVersionOk('18.20.0')).toBe(false);
    expect(nodeVersionOk('20.18.1')).toBe(false);
    expect(nodeVersionOk('20.19.0')).toBe(true);
    expect(nodeVersionOk('22.11.0')).toBe(false);
    expect(nodeVersionOk('22.12.0')).toBe(true);
    expect(nodeVersionOk('24.1.0')).toBe(true);
  });

  it('only accepts safe branch names', () => {
    expect(validBranch('main')).toBe(true);
    expect(validBranch('feature/print-checks')).toBe(true);
    expect(validBranch('a b')).toBe(false);
    expect(validBranch('../x')).toBe(false);
    expect(validBranch('x&calc')).toBe(false);
  });

  it('finds a branch commit in git\'s ref list', () => {
    const a = '1'.repeat(40), b = '2'.repeat(40), c = '3'.repeat(40);
    const text = `001e# service=git-upload-pack\n0000015b${a} HEAD\0multi_ack symref=HEAD:refs/heads/main\n003f${c} refs/heads/main-old\n003b${b} refs/heads/main\n0000`;
    expect(parseInfoRefs(text, 'main')).toBe(b);
    expect(parseInfoRefs(text, 'main-old')).toBe(c);
    expect(parseInfoRefs(text, 'nope')).toBeNull();
  });

  it('falls back to the GitHub API when the ref list is unavailable', async () => {
    const sha = 'a'.repeat(40);
    const fake = async (url: string) => url.includes('info/refs')
      ? new Response('nope', { status: 503 })
      : new Response(sha, { status: 200 });
    expect(await latestSha('main', fake)).toBe(sha);
    // the ref list answered but has no such branch -> a missing branch, not a sign-in problem
    const missing = async (url: string) => url.includes('info/refs') ? new Response('0000') : new Response('{}', { status: 404 });
    await expect(latestSha('gone', missing)).rejects.toThrow(/not found/);
  });

  it('writes a Windows shortcut target that checks for Node.js', () => {
    const cmd = windowsCmd();
    expect(cmd).toContain('node "%~dp0launcher.mjs" %*');
    expect(cmd).toContain('nodejs.org');
    expect(cmd.split('\r\n').length).toBeGreaterThan(5);
  });

  it('tells CHAD apart from other programs (ChatCAD included) on the port', async () => {
    const serve = (html: string) => new Promise<any>((r) => { const s = createServer((_q, res) => res.end(html)); s.listen(0, 'localhost', () => r(s)); });
    const mine = await serve('<html><head><title>CHAD</title></head></html>');
    const other = await serve('<html><title>Something else</title></html>');
    const chatcad = await serve('<html><head><title>ChatCAD</title></head></html>');
    try {
      expect(await portState(mine.address().port)).toBe('chatcad');
      expect(await portState(other.address().port)).toBe('other');
      expect(await portState(chatcad.address().port)).toBe('other');
      chatcad.close();
      const p = other.address().port;
      await new Promise((r) => other.close(r));
      expect(await portState(p)).toBe('free');
    } finally { mine.close(); other.close(); }
  });
});

describe('launcher sign-in for the private repo', () => {
  const sha = 'b'.repeat(40);
  const refs = `003b${sha} refs/heads/main\n0000`;
  /** GitHub as seen by the launcher: anonymous requests to a private repo get 401 (git) / 404 (API). */
  const github = (goodToken: string | null) => async (url: string, init: any) => {
    const auth = init?.headers?.authorization as string | undefined;
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : auth ? Buffer.from(auth.slice(6), 'base64').toString().split(':')[1] : null;
    const allowed = goodToken === null || token === goodToken;
    if (url.includes('info/refs')) return allowed ? new Response(refs) : new Response('', { status: 401 });
    return allowed ? new Response(sha) : new Response('{}', { status: 404 });
  };
  const helper = (answers: (string | null)[]) => {
    const calls: string[] = [];
    const credential = (action: string, c?: any) => {
      calls.push(action === 'fill' ? 'fill' : `${action}:${c.token}`);
      if (action !== 'fill') return null;
      const t = answers.shift();
      return t ? { username: 'example-user', token: t } : null;
    };
    return { calls, credential };
  };

  it('uses no sign-in when the repo is public', async () => {
    const h = helper([]); const state: any = {};
    expect((await checkGitHub('main', state, { fetchImpl: github(null), git: 'git', credential: h.credential })).sha).toBe(sha);
    expect(h.calls).toEqual([]);
    expect(state.private).toBeUndefined();
  });

  it('signs in once for a private repo, then remembers that it is private', async () => {
    const h = helper(['good', 'good']); const state: any = {};
    const r = await checkGitHub('main', state, { fetchImpl: github('good'), git: 'git', credential: h.credential });
    expect(r.sha).toBe(sha);
    expect(r.cred.token).toBe('good');
    expect(state.private).toBe(true);
    expect(h.calls).toEqual(['fill', 'approve:good']);
    // next start: asks the helper straight away (silent when the sign-in is saved)
    await checkGitHub('main', state, { fetchImpl: github('good'), git: 'git', credential: h.credential });
    expect(h.calls).toEqual(['fill', 'approve:good', 'fill', 'approve:good']);
  });

  it('forgets a sign-in GitHub no longer accepts and asks again', async () => {
    const h = helper(['old', 'new']); const state: any = { private: true };
    const r = await checkGitHub('main', state, { fetchImpl: github('new'), git: 'git', credential: h.credential });
    expect(r.cred.token).toBe('new');
    expect(h.calls).toEqual(['fill', 'reject:old', 'fill', 'approve:new']);
  });

  it('explains plainly when Git is missing or the sign-in is cancelled', async () => {
    await expect(checkGitHub('main', {}, { fetchImpl: github('x'), git: null, credential: () => null })).rejects.toThrow(/needs Git/);
    await expect(checkGitHub('main', {}, { fetchImpl: github('x'), git: 'git', credential: () => null })).rejects.toThrow(/did not finish/);
  });

  it('reads Git credential output and builds auth headers', () => {
    expect(parseCredential('protocol=https\r\nhost=github.com\r\nusername=example-user\r\npassword=gho_abc\r\n')).toEqual({ username: 'example-user', token: 'gho_abc' });
    expect(parseCredential('protocol=https\n')).toBeNull();
    expect(authHeaders(null)).toEqual({});
    expect(authHeaders({ token: 't' }, 'bearer')).toEqual({ authorization: 'Bearer t' });
    expect(Buffer.from(authHeaders({ username: 'u', token: 't' }).authorization.slice(6), 'base64').toString()).toBe('u:t');
  });

  it('finds Git in its default Windows folder even with a stale PATH', () => {
    expect(findGit({ ProgramFiles: 'C:\\Program Files' }, 'win32', (p: string) => p.endsWith('git.exe'))).toMatch(/Program Files[\\/]Git[\\/]cmd[\\/]git\.exe$/);
  });
});
