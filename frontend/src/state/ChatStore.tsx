// Chat-state context — holds the bits of ChatPage that must survive
// React Router unmounts (i.e. when the user pops over to Settings and
// back). Transient per-render state (sending flag, streaming text, error,
// interim STT, in-flight abort controller) stays inside ChatPage because
// it has no meaning across navigation.
//
// We deliberately keep this pure in-memory React state (no localStorage
// persistence) — interview practice sessions are ephemeral by design, but
// they shouldn't evaporate just because the user toggled to Settings.

import { createContext, useContext, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import type { ChatMessage, ImageData, Mode } from '../lib/types';

interface ChatStore {
  mode:        Mode;             setMode:        Dispatch<SetStateAction<Mode>>;
  history:     ChatMessage[];    setHistory:     Dispatch<SetStateAction<ChatMessage[]>>;
  buffer:      string;           setBuffer:      Dispatch<SetStateAction<string>>;
  pendingImgs: ImageData[];      setPendingImgs: Dispatch<SetStateAction<ImageData[]>>;
}

const ChatCtx = createContext<ChatStore | null>(null);

export function ChatStoreProvider({ children }: { children: ReactNode }) {
  const [mode,        setMode]        = useState<Mode>('general');
  const [history,     setHistory]     = useState<ChatMessage[]>([]);
  const [buffer,      setBuffer]      = useState<string>('');
  const [pendingImgs, setPendingImgs] = useState<ImageData[]>([]);

  return (
    <ChatCtx.Provider value={{ mode, setMode, history, setHistory, buffer, setBuffer, pendingImgs, setPendingImgs }}>
      {children}
    </ChatCtx.Provider>
  );
}

export function useChatStore(): ChatStore {
  const c = useContext(ChatCtx);
  if (!c) throw new Error('useChatStore must be used inside <ChatStoreProvider>');
  return c;
}
