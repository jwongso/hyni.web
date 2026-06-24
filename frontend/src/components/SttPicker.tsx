import type { SttEngineId } from '../stt/types';
import { listAdapters } from '../stt/registry';

interface Props {
  value: SttEngineId;
  onChange: (id: SttEngineId) => void;
  disabled?: boolean;
}

const ICONS: Record<string, string> = {
  webspeech:      '🌐',
  wstream:        '🔒',
  transformersjs: '🤗',
};

// Compact inline STT engine picker for the chat toolbar. Disabled options
// stay visible but greyed (unavailable in this browser / context, e.g.
// wstream on a non-isolated origin).
export function SttPicker({ value, onChange, disabled }: Props) {
  const metas = listAdapters();
  const current = metas.find((m) => m.id === value);
  return (
    <select
      className="engine-picker"
      value={value}
      disabled={disabled}
      title={current ? `${current.description}` : undefined}
      onChange={(e) => onChange(e.target.value as SttEngineId)}
    >
      {metas.map((m) => {
        const ok = m.isAvailable();
        const tag = m.capabilities.offline ? 'local'
                  : m.capabilities.cloud   ? 'cloud' : '';
        return (
          <option key={m.id} value={m.id} disabled={!ok}>
            {(ICONS[m.id] ?? '🎙')} {m.label}{tag ? ` · ${tag}` : ''}{ok ? '' : ' — unavailable'}
          </option>
        );
      })}
    </select>
  );
}
