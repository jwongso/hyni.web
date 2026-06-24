import { isValidElement } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatMessage } from '../lib/types';
import { DayDot } from './DayDot';
import { CopyButton } from './CopyButton';
import { MermaidBlock } from './MermaidBlock';

interface Props {
  messages: ChatMessage[];
  /** If non-empty, render an assistant bubble with this in-flight text. */
  streamingText?: string;
  /** Optional reasoning-model chain-of-thought streaming alongside the answer. */
  streamingReasoning?: string;
  /** Tool calls that completed during the in-flight stream. */
  streamingToolCalls?: NonNullable<ChatMessage['tool_calls']>;
  /** If true (and streamingText is empty), show a "thinking…" placeholder. */
  pendingAssistant?: boolean;
  /** Provider/model currently selected — shown on in-flight assistant bubbles. */
  currentProvider?: string;
  currentModel?: string;
}

// Short-form provider+model label, e.g. "openai · gpt-4o" or "local · Qwen3-8B".
// Strips file extensions and long org prefixes so the bubble header stays compact.
function modelLabel(provider?: string, model?: string): string {
  if (!provider && !model) return 'assistant';
  let m = (model || '').trim();
  m = m.replace(/\.(gguf|bin|safetensors)$/i, '');
  m = m.replace(/^[A-Za-z0-9_.-]+[_/]/, '');
  if (provider && m)   return `${provider} · ${m}`;
  if (provider)        return provider;
  return m || 'assistant';
}

// Renders the assistant reply as GitHub-flavoured Markdown so headings,
// bold/italic, lists, tables, inline code and fenced code blocks all
// render naturally. react-markdown sanitises by default (no raw HTML
// passthrough), so paste-from-LLM content is safe.
//
// We open ALL links in a new tab — interview answers often cite blog
// posts / docs, and we don't want the user to lose their chat history
// by navigating away.
function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
          // Intercept <pre> so fenced ```mermaid blocks render as a
          // proper diagram. react-markdown wraps every fenced block in
          // <pre><code class="language-X">…</code></pre>; for mermaid
          // we replace that whole subtree with our lazy MermaidBlock.
          // All other languages keep the default <pre><code> chrome
          // (and the existing CSS in .chat__msg pre + .md code).
          pre: ({ children, ...props }) => {
            const child: any = Array.isArray(children)
              ? children[0]
              : children;
            if (isValidElement(child)) {
              const ch: any = child;
              const cls: string = ch.props?.className ?? '';
              if (cls.split(/\s+/).includes('language-mermaid')) {
                const code = typeof ch.props?.children === 'string'
                  ? ch.props.children
                  : Array.isArray(ch.props?.children)
                    ? ch.props.children.join('')
                    : '';
                return <MermaidBlock code={code} />;
              }
            }
            return <pre {...props}>{children}</pre>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

// Collapsible tool-call disclosure. One <details> per call; the summary
// shows the qualified tool name + a short arg preview, and the body shows
// the full args (pretty-printed) and the flattened result text.
function ToolCallsBlock({ calls }: { calls: NonNullable<ChatMessage['tool_calls']> }) {
  if (!calls || calls.length === 0) return null;
  return (
    <details className="tool-calls" open={false}>
      <summary>
        🛠 {calls.length} tool call{calls.length === 1 ? '' : 's'}
        <span className="tool-calls__hint">(click to expand)</span>
      </summary>
      <div className="tool-calls__body">
        {calls.map((c, i) => {
          const args = (() => {
            try { return JSON.stringify(c.arguments, null, 2); }
            catch { return String(c.arguments ?? '{}'); }
          })();
          return (
            <div key={i} className={'tool-call ' + (c.is_error ? 'tool-call--err' : '')}>
              <div className="tool-call__head">
                <span className="tool-call__name">{c.name}</span>
                {c.latency_ms > 0 && (
                  <span className="tool-call__latency">{c.latency_ms}ms</span>
                )}
                {c.is_error && <span className="tool-call__badge">error</span>}
              </div>
              <details className="tool-call__args" open={false}>
                <summary>args</summary>
                <pre>{args}</pre>
              </details>
              <details className="tool-call__result" open={false}>
                <summary>result</summary>
                <pre>{c.result}</pre>
              </details>
            </div>
          );
        })}
      </div>
    </details>
  );
}

// Collapsible chain-of-thought disclosure. Default-collapsed so the visible
// answer stays clean; the user can open it if they want to see how the
// reasoning model got there.
function ReasoningBlock({ text }: { text: string }) {
  if (!text) return null;
  return (
    <details className="reasoning">
      <summary>💭 Thinking…  <span className="reasoning__hint">(click to expand)</span></summary>
      <div className="reasoning__body">{text}</div>
    </details>
  );
}

// Renders a conversation as bubbles. Pre-wraps long content; image
// attachments render as small previews under the user message.
// Each bubble carries a tiny coloured auspice dot derived from its
// timestamp (via fengshui.overhired.work) — green = lucky day,
// gold = ordinary, red = unlucky. Silently absent if the API is offline.
export function ChatMessages({
  messages, streamingText, streamingReasoning, streamingToolCalls,
  pendingAssistant, currentProvider, currentModel,
}: Props) {
  if (messages.length === 0 && !pendingAssistant && !streamingText && !streamingReasoning &&
      !(streamingToolCalls && streamingToolCalls.length > 0)) {
    return (
      <div className="chat__msg system">
        Tap <strong>Start listening</strong>, have your interviewer ask a
        question, then press <kbd>s</kbd> to send the transcript and get an
        answer.
      </div>
    );
  }
  const liveLabel = modelLabel(currentProvider, currentModel);
  return (
    <>
      {messages.map((m, i) => {
        const label = m.role === 'assistant' ? modelLabel(m.provider, m.model) : m.role;
        const isAsst = m.role === 'assistant';
        return (
          <div key={i} className={`chat__msg ${m.role}`}>
            <div className="role">
              <span>{label}</span>
              {m.at != null && <DayDot at={m.at} />}
              {isAsst && m.text && (
                <CopyButton text={m.text} title="Copy reply" />
              )}
            </div>
            {isAsst && m.tool_calls && m.tool_calls.length > 0
              ? <ToolCallsBlock calls={m.tool_calls} /> : null}
            {isAsst && m.reasoning ? <ReasoningBlock text={m.reasoning} /> : null}
            {isAsst ? <Markdown text={m.text} /> : m.text}
            {m.images && m.images.length > 0 && (
              <div className="images">
                {m.images.map((img, j) => (
                  <img
                    key={j}
                    src={`data:${img.mime_type};base64,${img.image_base64}`}
                    alt=""
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
      {(streamingText !== undefined && streamingText.length > 0) ||
       (streamingReasoning !== undefined && streamingReasoning.length > 0) ||
       (streamingToolCalls && streamingToolCalls.length > 0) ? (
        <div className="chat__msg assistant">
          <div className="role">
            <span>{liveLabel}</span>
            <span style={{ opacity: 0.6 }}>· streaming…</span>
            {streamingText && <CopyButton text={streamingText} title="Copy (so far)" />}
          </div>
          {streamingToolCalls && streamingToolCalls.length > 0
            ? <ToolCallsBlock calls={streamingToolCalls} /> : null}
          {streamingReasoning ? <ReasoningBlock text={streamingReasoning} /> : null}
          {streamingText ? <Markdown text={streamingText} /> : null}
          {streamingText ? <span className="cursor-blink">▍</span> : null}
        </div>
      ) : null}
      {pendingAssistant && !streamingText && !streamingReasoning &&
       !(streamingToolCalls && streamingToolCalls.length > 0) && (
        <div className="chat__msg assistant">
          <div className="role">{liveLabel}</div>
          <em>thinking…</em>
        </div>
      )}
    </>
  );
}
