import type { ReactNode } from 'react';

/** Tiny, safe markdown subset for chat replies: **bold**, `code`, and "- " bullets. No HTML is ever injected. */
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0; let m: RegExpExecArray | null; let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    out.push(t.startsWith('**') ? <b key={`${keyBase}-${k++}`}>{t.slice(2, -2)}</b> : <code key={`${keyBase}-${k++}`}>{t.slice(1, -1)}</code>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function MiniMarkdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (bullets.length) blocks.push(<ul key={`ul${blocks.length}`}>{bullets.map((b, i) => <li key={i}>{inline(b, `li${blocks.length}-${i}`)}</li>)}</ul>);
    bullets = [];
  };
  text.split('\n').forEach((line, i) => {
    const b = /^\s*[-*]\s+(.*)$/.exec(line);
    if (b) { bullets.push(b[1]); return; }
    flush();
    if (line.trim()) blocks.push(<p key={`p${i}`}>{inline(line, `p${i}`)}</p>);
  });
  flush();
  return <>{blocks}</>;
}
