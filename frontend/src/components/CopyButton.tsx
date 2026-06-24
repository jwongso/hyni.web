import { useState } from 'react';

interface Props {
  /** Text payload to copy. Markdown source is passed verbatim so users
   *  can paste it elsewhere and keep formatting. */
  text: string;
  /** Tooltip / aria-label override (default: "Copy to clipboard"). */
  title?: string;
}

// Tiny copy-to-clipboard button. Uses navigator.clipboard with a graceful
// fallback to a hidden textarea + document.execCommand for ancient
// browsers (still seen on locked-down corporate laptops).
export function CopyButton({ text, title = 'Copy to clipboard' }: Props) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      className={'copy-btn' + (copied ? ' copy-btn--ok' : '')}
      onClick={copy}
      aria-label={title}
      title={copied ? 'Copied!' : title}
    >
      {copied ? (
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2 8.5l3.5 3.5L14 4" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="4" y="4" width="9" height="11" rx="1.5"
                fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M3 12V2.5A1.5 1.5 0 0 1 4.5 1H11"
                fill="none" stroke="currentColor" strokeWidth="1.5"
                strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}
