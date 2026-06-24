import type { ChatMessage } from '../lib/types';

interface Props {
  messages: ChatMessage[];
  pendingAssistant?: boolean;
}

// Renders a conversation as bubbles. Pre-wraps long content; image
// attachments render as small previews under the user message.
export function ChatMessages({ messages, pendingAssistant }: Props) {
  if (messages.length === 0 && !pendingAssistant) {
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
      {pendingAssistant && (
        <div className="chat__msg assistant">
          <div className="role">assistant</div>
          <em>thinking…</em>
        </div>
      )}
    </>
  );
}
