import type { TtsEngineId } from '../tts/types';
import { listSpeakers } from '../tts/registry';

interface Props {
  value: TtsEngineId;
  onChange: (id: TtsEngineId) => void;
  disabled?: boolean;
}

const ICONS: Record<string, string> = {
  webspeech:  '🗣',
  piper:      '🔒',
  elevenlabs: '☁️',
};

// Compact inline TTS engine picker. Matches the SttPicker shape for visual
// consistency. Unavailable engines stay visible-but-disabled so users see
// the menu of options.
export function TtsPicker({ value, onChange, disabled }: Props) {
  const metas = listSpeakers();
  const current = metas.find((m) => m.id === value);
  return (
    <select
      className="engine-picker"
      value={value}
      disabled={disabled}
      title={current ? current.description : undefined}
      onChange={(e) => onChange(e.target.value as TtsEngineId)}
    >
      {metas.map((m) => {
        const ok  = m.isAvailable();
        const tag = m.capabilities.offline ? 'local'
                  : m.capabilities.cloud   ? 'cloud' : '';
        const qual = m.capabilities.voiceQuality;
        return (
          <option key={m.id} value={m.id} disabled={!ok}>
            {(ICONS[m.id] ?? '🔊')} {m.label}{tag ? ` · ${tag}` : ''}
            {qual !== 'system' ? ` · ${qual}` : ''}
            {ok ? '' : ' — unavailable'}
          </option>
        );
      })}
    </select>
  );
}
