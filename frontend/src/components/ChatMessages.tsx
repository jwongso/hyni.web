import type { ChatMessage } from '../lib/types';
import { DayDot } from './DayDot';

interface Props {
  messages: ChatMessage[];
  /** If non-empty, render an assistant bubble with this in-flight text. */
  streamingText?: string;
  /** Optional reasoning-model chain-of-thought streaming alongside the answer. */
  streamingReasoning?: string;
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
  messages, streamingText, streamingReasoning,
  pendingAssistant, currentProvider, currentModel,
}: Props) {
  if (messages.length === 0 && !pendingAssistant && !streamingText && !streamingReasoning) {
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
        return (
          <div key={i} className={`chat__msg ${m.role}`}>
            <div className="role">
              <span>{label}</span>
              {m.at != null && <DayDot at={m.at} />}
            </div>
            {m.role === 'assistant' && m.reasoning ? <ReasoningBlock text={m.reasoning} /> : null}
            {m.text}
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
       (streamingReasoning !== undefined && streamingReasoning.length > 0) ? (
        <div className="chat__msg assistant">
          <div className="role">
            <span>{liveLabel}</span>
            <span style={{ opacity: 0.6 }}>· streaming…</span>
          </div>
          {streamingReasoning ? <ReasoningBlock text={streamingReasoning} /> : null}
          {streamingText}
          {streamingText ? <span className="cursor-blink">▍</span> : null}
        </div>
      ) : null}
      {pendingAssistant && !streamingText && !streamingReasoning && (
        <div className="chat__msg assistant">
          <div className="role">{liveLabel}</div>
          <em>thinking…</em>
        </div>
      )}
    </>
  );
}
