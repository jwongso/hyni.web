import { useEffect, useState } from 'react';
import { storage } from '../lib/storage';
import { fetchConfig } from '../lib/api';
import {
  DEFAULT_SETTINGS,
  EMPTY_PROFILE,
  type AppSettings,
  type ProviderId,
  type ServerConfig,
  type SttEngineId,
  type UserProfile,
} from '../lib/types';
import { listRecognizers } from '../stt';
import { listVoices, onVoicesReady } from '../tts/webspeech';

// Settings page — owns the persistent identity context that gets injected
// into every system prompt, plus app/STT/TTS preferences. All persisted in
// localStorage.
export function SettingsPage() {
  const [profile,  setProfile]  = useState<UserProfile>(() => storage.loadProfile());
  const [settings, setSettings] = useState<AppSettings>(() => storage.loadSettings());
  const [config,   setConfig]   = useState<ServerConfig | null>(null);
  const [voices,   setVoices]   = useState<SpeechSynthesisVoice[]>(listVoices());
  const [saved,    setSaved]    = useState<string>('');

  useEffect(() => {
    fetchConfig().then(setConfig).catch(() => {});
    const unsub = onVoicesReady(setVoices);
    return unsub;
  }, []);

  const profileChange = (k: keyof UserProfile) => (e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) =>
    setProfile({ ...profile, [k]: e.target.value });

  const settingsChange = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) =>
    setSettings({ ...settings, [k]: v });

  const save = () => {
    storage.saveProfile(profile);
    storage.saveSettings(settings);
    setSaved(`Saved at ${new Date().toLocaleTimeString()}`);
    setTimeout(() => setSaved(''), 2500);
  };

  const reset = () => {
    if (!confirm('Reset all profile and settings? This cannot be undone.')) return;
    storage.clearAll();
    setProfile(EMPTY_PROFILE);
    setSettings(DEFAULT_SETTINGS);
  };

  const onResumeFile = async (file: File) => {
    // Plain-text resumes only for now. PDF parsing can be added later.
    if (!file.type.startsWith('text/') && !file.name.toLowerCase().endsWith('.txt') && !file.name.toLowerCase().endsWith('.md')) {
      alert(`Only plain-text or markdown files supported in this build. Got "${file.type || file.name}".`);
      return;
    }
    const text = await file.text();
    setProfile({ ...profile, resume_text: text });
  };

  const recognizers = listRecognizers();

  return (
    <div className="page">
      <h1>Settings</h1>

      <h2>Identity context (injected into every system prompt)</h2>
      <div className="field">
        <label>Target role / company</label>
        <input
          placeholder="e.g. Senior Software Engineer at Amazon"
          value={profile.target_role}
          onChange={profileChange('target_role')}
        />
      </div>
      <div className="field">
        <label>Resume / CV (plain text — paste, or load a .txt/.md file)</label>
        <textarea
          rows={12}
          placeholder="Paste your resume here. The behavioral mode will ground STAR answers in this content."
          value={profile.resume_text}
          onChange={profileChange('resume_text')}
        />
        <div className="row" style={{ marginTop: '0.5rem' }}>
          <input
            type="file"
            accept=".txt,.md,text/*"
            style={{ width: 'auto' }}
            onChange={(e) => e.target.files?.[0] && onResumeFile(e.target.files[0])}
          />
          <small>{profile.resume_text.length} characters loaded</small>
        </div>
      </div>
      <div className="field">
        <label>Strengths (free text)</label>
        <textarea rows={3} value={profile.strengths}  onChange={profileChange('strengths')} />
      </div>
      <div className="field">
        <label>Weaknesses / growth areas (free text)</label>
        <textarea rows={3} value={profile.weaknesses} onChange={profileChange('weaknesses')} />
      </div>
      <div className="field">
        <label>Additional notes (motivations, salary expectations, anything else)</label>
        <textarea rows={3} value={profile.extra_notes} onChange={profileChange('extra_notes')} />
      </div>

      <h2>LLM provider</h2>
      <div className="row">
        <div className="field" style={{ flex: 1 }}>
          <label>Provider</label>
          <select
            value={settings.provider}
            onChange={(e) => settingsChange('provider', e.target.value as ProviderId)}
          >
            {config?.providers.map(p => (
              <option key={p.id} value={p.id}>
                {p.id} {p.has_key ? '(key configured)' : '(no key on server)'}
              </option>
            ))}
            {!config && <option value="openai">openai</option>}
          </select>
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Model (blank = server default)</label>
          <input
            placeholder={config?.providers.find(p => p.id === settings.provider)?.default_model}
            value={settings.model}
            onChange={(e) => settingsChange('model', e.target.value)}
          />
        </div>
      </div>
      <div className="row">
        <div className="field" style={{ flex: 1 }}>
          <label>Temperature ({settings.temperature.toFixed(2)})</label>
          <input
            type="range" min={0} max={1.5} step={0.05}
            value={settings.temperature}
            onChange={(e) => settingsChange('temperature', Number(e.target.value))}
          />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Max tokens</label>
          <input
            type="number" min={256} max={32768} step={256}
            value={settings.max_tokens}
            onChange={(e) => settingsChange('max_tokens', Number(e.target.value))}
          />
        </div>
      </div>

      <h2>Speech-to-Text engine</h2>
      <div className="field">
        <select
          value={settings.stt_engine}
          onChange={(e) => settingsChange('stt_engine', e.target.value as SttEngineId)}
        >
          {recognizers.map(r => (
            <option key={r.id} value={r.id} disabled={!r.available}>
              {r.label}{r.available ? '' : ' — not available'}
            </option>
          ))}
        </select>
        <small>{recognizers.find(r => r.id === settings.stt_engine)?.description}</small>
      </div>

      <h2>Text-to-Speech (Web Speech API)</h2>
      <div className="row">
        <div className="field" style={{ flex: 2 }}>
          <label>Voice</label>
          <select
            value={settings.tts_voice_uri}
            onChange={(e) => settingsChange('tts_voice_uri', e.target.value)}
          >
            <option value="">(browser default)</option>
            {voices.map(v => (
              <option key={v.voiceURI} value={v.voiceURI}>
                {v.name} — {v.lang}{v.default ? ' [default]' : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Rate ({settings.tts_rate.toFixed(2)}x)</label>
          <input type="range" min={0.5} max={2} step={0.05}
                 value={settings.tts_rate}
                 onChange={(e) => settingsChange('tts_rate', Number(e.target.value))} />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Pitch ({settings.tts_pitch.toFixed(2)})</label>
          <input type="range" min={0.5} max={2} step={0.05}
                 value={settings.tts_pitch}
                 onChange={(e) => settingsChange('tts_pitch', Number(e.target.value))} />
        </div>
      </div>
      <div className="field">
        <label>
          <input
            type="checkbox"
            checked={settings.speak_replies}
            onChange={(e) => settingsChange('speak_replies', e.target.checked)}
            style={{ width: 'auto', marginRight: '0.5rem' }}
          />
          Speak assistant replies aloud
        </label>
      </div>

      <div className="row" style={{ marginTop: '1.5rem' }}>
        <button onClick={save}>Save</button>
        <button className="secondary" onClick={reset}>Reset all</button>
        {saved && <span className="status-pill ok">{saved}</span>}
      </div>
    </div>
  );
}
