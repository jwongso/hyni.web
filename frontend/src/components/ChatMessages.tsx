import type { ChatMessage } from '../lib/types';

interface Props {
  messages: ChatMessage[];
  /** If non-empty, render an assistant bubble with this in-flight text. */
  streamingText?: string;
  /** If true (and streamingText is empty), show a "thinking…" placeholder. */
  pendingAssistant?: boolean;
}

// Renders a conversation as bubbles. Pre-wraps long content; image
// attachments render as small previews under the user message.
export function ChatMessages({ messages, streamingText, pendingAssistant }: Props) {
  if (messages.length === 0 && !pendingAssistant && !streamingText) {
    return (
      <div className="chat__msg system">
        Tap <strong>Start listening</strong>, have your interviewer ask a
        question, then press <kbd>s</kbd> to send the transcript and get an
        answer.
      </div>
    );
  }
  return (
    <>
      {messages.map((m, i) => (
        <div key={i} className={`chat__msg ${m.role}`}>
          <div className="role">{m.role}</div>
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
      ))}
      {streamingText !== undefined && streamingText.length > 0 && (
        <div className="chat__msg assistant">
          <div className="role">assistant <span style={{ opacity: 0.6 }}>· streaming…</span></div>
          {streamingText}
          <span className="cursor-blink">▍</span>
        </div>
      )}
      {pendingAssistant && !streamingText && (
        <div className="chat__msg assistant">
          <div className="role">assistant</div>
          <em>thinking…</em>
        </div>
      )}
    </>
  );
}
