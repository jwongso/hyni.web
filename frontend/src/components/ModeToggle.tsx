import { MODES, type Mode } from '../lib/types';

interface Props {
  value: Mode;
  onChange: (m: Mode) => void;
  disabled?: boolean;
}

const LABELS: Record<Mode, string> = {
  general:       'General',
  coding:        'Coding',
  behavioral:    'Behavioral (STAR)',
  system_design: 'System Design',
};

export function ModeToggle({ value, onChange, disabled }: Props) {
  return (
    <div className="mode-toggle" role="tablist" aria-label="Answer mode">
      {MODES.map(m => (
        <button
          key={m}
          role="tab"
          aria-selected={value === m}
          className={value === m ? 'active' : ''}
          disabled={disabled}
          onClick={() => onChange(m)}
        >
          {LABELS[m]}
        </button>
      ))}
    </div>
  );
}
