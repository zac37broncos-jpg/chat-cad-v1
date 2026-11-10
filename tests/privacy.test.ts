import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// CHAD is public and bring-your-own-key: users type their own AI key into the app, and the
// repository must never carry anyone's key, token, password, e-mail address or computer paths.
// This scans every text file in the repository, not only the app.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/** Folders that are made by tools, never committed. */
const GENERATED = /^(node_modules|dist|dist-e2e|\.git|bench-results|smoke-results|smoke-report|verify\/print\/out|verify\/print\/\.venv)$|(^|\/)__pycache__$/;
const TEXT = /\.(ts|tsx|js|mjs|cjs|json|md|txt|css|html|py|sh|bat|yml|yaml|svg)$|(^|\/)(LICENSE|_headers|\.gitignore)$/;
/** Licence texts quote their authors' e-mail addresses; the lockfile lists package download addresses. */
const THIRD_PARTY_TEXT = new Set(['public/THIRD_PARTY_NOTICES.txt', 'package-lock.json']);

function walk(dir: string): string[] {
  return readdirSync(join(root, dir || '.')).flatMap((n) => {
    const p = dir ? `${dir}/${n}` : n;
    if (GENERATED.test(p)) return [];
    return statSync(join(root, p)).isDirectory() ? walk(p) : [p];
  });
}
const files = walk('').filter((f) => TEXT.test(f));

/** Shapes of real credentials (AI providers, GitHub, Slack, AWS, private keys). */
const SECRET_LIKE = [
  /sk-ant-[A-Za-z0-9_-]{8,}/,
  /\bsk-(proj-)?[A-Za-z0-9]{20,}/,
  /AIza[0-9A-Za-z_-]{30,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /xox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /xai-[A-Za-z0-9]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /Bearer [A-Za-z0-9._-]{24,}/,
];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
/** A real person's folder. Tests and docs use the placeholder "Example" (or a variable such as %USERPROFILE%). */
const PERSONAL_PATH = /[A-Za-z]:\\{1,2}Users\\{1,2}(?!Example\b)[A-Za-z0-9._-]+|\/home\/(?!example\b)[a-z][a-z0-9._-]*\/|\/Users\/(?!example\b)[A-Za-z][A-Za-z0-9._-]*\/|\/mnt\/project-files/;

describe('nothing private in the public repository', () => {
  it('scans the whole repository', () => {
    expect(files.length).toBeGreaterThan(150);
    for (const f of ['README.md', 'LICENSE', 'src/ui/App.tsx', 'proxy/core.mjs', 'docs/BYOK_AI.md']) expect(files, f).toContain(f);
  });

  it('no API keys, tokens, passwords or private keys in any file', () => {
    for (const f of files) {
      const text = read(f);
      for (const re of SECRET_LIKE) expect(text, `${f} matches ${re}`).not.toMatch(re);
    }
  });

  it('no e-mail addresses outside the third-party licence texts', () => {
    for (const f of files) if (!THIRD_PARTY_TEXT.has(f)) expect(read(f), f).not.toMatch(EMAIL);
  });

  it('no personal folders from anyone\'s computer', () => {
    for (const f of files) if (!THIRD_PARTY_TEXT.has(f)) expect(read(f), f).not.toMatch(PERSONAL_PATH);
  });

  it('the patterns themselves catch what they are meant to catch', () => {
    // Built from pieces so this file never holds a whole key-shaped string.
    const fakeKey = ['sk', 'ant', 'api03', 'x'.repeat(12)].join('-');
    expect(SECRET_LIKE.some((re) => re.test(fakeKey))).toBe(true);
    expect(SECRET_LIKE.some((re) => re.test(`ghp_${'a'.repeat(36)}`))).toBe(true);
    expect(EMAIL.test(['someone', 'example.com'].join('@'))).toBe(true);
    expect(PERSONAL_PATH.test(['C:', 'Users', 'Someone', 'Desktop'].join('\\'))).toBe(true);
    expect(PERSONAL_PATH.test(['C:', 'Users', 'Example', 'Desktop'].join('\\'))).toBe(false);
    expect(PERSONAL_PATH.test(['', 'home', 'someone', 'project'].join('/'))).toBe(true);
  });
});
