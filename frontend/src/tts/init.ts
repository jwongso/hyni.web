// Side-effect-only imports that register every shipped TTS speaker into
// the central registry at app startup. Mirrors stt/init.ts — see that
// file for the rationale (static imports vs racy dynamic ones).

import './WebSpeechSpeaker';
import './PiperSpeaker';
import './ElevenLabsSpeaker';
