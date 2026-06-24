import { useEffect, useRef, useState } from 'react';

interface Props {
  /** Raw Mermaid source (the body of a ```mermaid fenced code block). */
  code: string;
}

// Lazily-loaded Mermaid renderer. The mermaid package itself is ~700 KB
// minified — far too heavy to pay for unconditionally — so we dynamic
// import on first use. The promise is cached at module scope so every
// subsequent diagram on the page shares the load.
//
// While `code` is incomplete (mid-stream) or syntactically invalid,
// mermaid.parse() throws; we fall back to a <pre> block so the user
// still sees the raw source. Once the stream completes and the source
// is valid, the diagram replaces the <pre> in-place.

let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;
function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then(({ default: m }) => {
      m.initialize({
        startOnLoad: false,
        // Match the SPA dark palette so diagrams don't blind users.
        theme: 'dark',
        themeVariables: {
          fontFamily: 'inherit',
          fontSize: '14px',
        },
        securityLevel: 'strict',  // disallow inline scripts in user-supplied diagrams
        flowchart: { htmlLabels: false, useMaxWidth: true },
      });
      return m;
    });
  }
  return mermaidPromise;
}

let idCounter = 0;

export function MermaidBlock({ code }: Props) {
  const [svg, setSvg] = useState<string>('');
  const [err, setErr] = useState<string>('');
  const idRef = useRef('mmd-' + (++idCounter));

  useEffect(() => {
    let cancelled = false;
    const trimmed = code.trim();
    if (!trimmed) { setSvg(''); setErr(''); return; }

    (async () => {
      try {
        const mermaid = await loadMermaid();
        // parse() throws for incomplete/syntactically invalid input.
        // Catching here keeps streaming partial code from rendering
        // a broken diagram every keystroke.
        await mermaid.parse(trimmed);
        const { svg } = await mermaid.render(idRef.current, trimmed);
        if (!cancelled) { setSvg(svg); setErr(''); }
      } catch (e: any) {
        if (!cancelled) {
          setSvg('');
          setErr(e?.message ?? String(e));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [code]);

  if (svg) {
    return (
      <div className="mermaid-block">
        <div className="mermaid-block__svg"
             dangerouslySetInnerHTML={{ __html: svg }} />
        <details className="mermaid-block__src">
          <summary>view source</summary>
          <pre><code>{code}</code></pre>
        </details>
      </div>
    );
  }

  // Stream-in / parse-error fallback — show the raw source, with a
  // muted hint only after a real parse error settled (not during
  // streaming, when err is "" because we haven't tried to render yet).
  return (
    <pre className={'mermaid-block__fallback' + (err ? ' mermaid-block__fallback--err' : '')}>
      <code>{code}</code>
      {err && <div className="mermaid-block__err">⚠ mermaid: {err}</div>}
    </pre>
  );
}
