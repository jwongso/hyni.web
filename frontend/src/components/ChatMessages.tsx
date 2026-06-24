import type { ChatMessage } from '../lib/types';
import { DayDot } from './DayDot';

interface Props {
  messages: ChatMessage[];
  /** If non-empty, render an assistant bubble with this in-flight text. */
  streamingText?: string;
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
  // Strip .gguf / .bin etc.
  m = m.replace(/\.(gguf|bin|safetensors)$/i, '');
  // Strip leading org/, owner_ prefixes for HF-style names.
  m = m.replace(/^[A-Za-z0-9_.-]+[_/]/, '');
  if (provider && m)   return `${provider} · ${m}`;
  if (provider)        return provider;
  return m || 'assistant';
}

// Renders a conversation as bubbles. Pre-wraps long content; image
// attachments render as small previews under the user message.
// Each bubble carries a tiny coloured auspice dot derived from its
// timestamp (via fengshui.overhired.work) — green = lucky day,
// gold = ordinary, red = unlucky. Silently absent if the API is offline.
export function ChatMessages({
  messages, streamingText, pendingAssistant, currentProvider, currentModel,
}: Props) {
  if (messages.length === 0 && !pendingAssistant && !streamingText) {
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
      {streamingText !== undefined && streamingText.length > 0 && (
        <div className="chat__msg assistant">
          <div className="role">
            <span>{liveLabel}</span>
            <span style={{ opacity: 0.6 }}>· streaming…</span>
          </div>
          {streamingText}
          <span className="cursor-blink">▍</span>
        </div>
      )}
      {pendingAssistant && !streamingText && (
        <div className="chat__msg assistant">
          <div className="role">{liveLabel}</div>
          <em>thinking…</em>
        </div>
      )}
    </>
  );
}
