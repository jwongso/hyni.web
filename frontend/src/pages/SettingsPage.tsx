import { useEffect, useRef, useState } from 'react';
import { fetchConfig, probeProviderKey } from '../lib/api';
import { storage } from '../lib/storage';
import { isPdfFile, pdfToText } from '../lib/pdf';
import {
  DEFAULT_SETTINGS,
  EMPTY_PROFILE,
  PROVIDER_IDS,
  type ApiKeyBag,
  type AppSettings,
  type ProviderId,
  type ServerConfig,
  type UserProfile,
} from '../lib/types';
import { useSpeaker } from '../tts/useSpeaker';

// Settings page — owns:
//   • Identity context (target role, resume from PDF/text, strengths, ...)
//   • LLM provider + model + sampling
//   • Per-provider local API keys (BYOK) + owner-token for shared deployments
//   • TTS voice + rate/pitch + speak toggle (engine itself is fixed to
//     Web Speech for now; the STT/TTS abstractions still live in stt/ + tts/
//     so swapping later is a one-file change).
//   • Response streaming toggle
//
// Everything is persisted to localStorage via `storage`.
export function SettingsPage() {
  const [profile,  setProfile]   = useState<UserProfile>(() => storage.loadProfile());
  const [settings, setSettings]  = useState<AppSettings>(() => storage.loadSettings());
  const [config,   setConfig]    = useState<ServerConfig | null>(null);
  const [saved,    setSaved]     = useState<string>('');
  const [pdfBusy,  setPdfBusy]   = useState<string>('');
  const [keyShow,  setKeyShow]   = useState<Record<string, boolean>>({});
  const [showOwner, setShowOwner] = useState(false);
  const [probe,    setProbe]     = useState<Record<string, string>>({});

  useEffect(() => {
    fetchConfig().then(setConfig).catch(() => {});
  }, []);

  // Re-probe /api/config whenever the owner token changes so the UI reflects
  // whether the user now counts as the owner.
  const ownerTokenRef = useRef(settings.owner_token);
  useEffect(() => {
    if (ownerTokenRef.current === settings.owner_token) return;
    ownerTokenRef.current = settings.owner_token;
    fetchConfig().then(setConfig).catch(() => {});
  }, [settings.owner_token]);

  // TTS hook — supplies the voice list for the picker below.
  const tts = useSpeaker(settings.tts_engine);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------
  const profileChange =
    (k: keyof UserProfile) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setProfile({ ...profile, [k]: e.target.value });

  const settingsChange = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) =>
    setSettings({ ...settings, [k]: v });

  const keyChange = (p: ProviderId, v: string) =>
    setSettings({ ...settings, api_keys: { ...settings.api_keys, [p]: v } });

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

  const clearAllKeys = () => {
    if (!confirm('Clear all locally-stored API keys?')) return;
    setSettings({ ...settings, api_keys: { ...DEFAULT_SETTINGS.api_keys } });
  };

  const onResumeFile = async (file: File) => {
    try {
      if (isPdfFile(file)) {
        setPdfBusy(`Reading ${file.name}…`);
        const text = await pdfToText(file, (p, t) => setPdfBusy(`Reading ${file.name} — page ${p}/${t}`));
        setProfile({ ...profile, resume_text: text });
        setPdfBusy(`Loaded ${text.length.toLocaleString()} chars from ${file.name}`);
        setTimeout(() => setPdfBusy(''), 3000);
        return;
      }
      const looksText = file.type.startsWith('text/')
                    || file.name.toLowerCase().endsWith('.txt')
                    || file.name.toLowerCase().endsWith('.md');
      if (!looksText) {
        alert(`Unsupported file: ${file.type || file.name}. Use PDF, .txt, or .md.`);
        return;
      }
      const text = await file.text();
      setProfile({ ...profile, resume_text: text });
      setPdfBusy(`Loaded ${text.length.toLocaleString()} chars from ${file.name}`);
      setTimeout(() => setPdfBusy(''), 3000);
    } catch (e: any) {
      setPdfBusy(`Failed to read file: ${e?.message ?? e}`);
    }
  };

  const testKey = async (p: ProviderId) => {
    const key = settings.api_keys[p];
    if (!key) {
      setProbe({ ...probe, [p]: '⚠ Enter a key first' });
      return;
    }
    setProbe({ ...probe, [p]: 'Testing…' });
    try {
      const r = await probeProviderKey(p, key);
      setProbe({
        ...probe,
        [p]: r.success
          ? `✓ Key works (${r.latency_ms} ms)`
          : `✗ ${r.error || ('HTTP ' + r.http_status)}`,
      });
    } catch (e: any) {
      setProbe({ ...probe, [p]: `✗ ${e?.message ?? e}` });
    }
  };

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------
  const ownerModeServer = config?.owner_mode_enabled ?? false;
  const isOwner         = config?.is_owner ?? !ownerModeServer;

  // ---------------------------------------------------------------------------
  return (
    <div className="page">
      <h1>Settings</h1>

      {/* ===== Identity context ===================================== */}
      <h2>Identity context <small style={{ color: 'var(--muted)' }}>(injected into every system prompt)</small></h2>

      <div className="field">
        <label>Role / Job description</label>
        <textarea
          rows={6}
          placeholder={
            'Paste the role title plus (optionally) the full job description, ' +
            'responsibilities, requirements, level, team, comp expectations — ' +
            'anything that helps the LLM tailor answers. e.g.:\n\n' +
            'Senior Software Engineer — Distributed Systems, Amazon (Auckland)\n' +
            'Responsibilities: …\nMust-haves: …\nNice-to-haves: …'
          }
          value={profile.target_role}
          onChange={profileChange('target_role')}
        />
        <small>{profile.target_role.length.toLocaleString()} characters</small>
      </div>

      <div className="field">
        <label>Resume / CV</label>
        <div className="row" style={{ marginBottom: '0.5rem' }}>
          <input
            type="file"
            accept=".pdf,.txt,.md,application/pdf,text/*"
            style={{ width: 'auto', flex: '0 0 auto' }}
            onChange={(e) => e.target.files?.[0] && void onResumeFile(e.target.files[0])}
          />
          <small>PDF (text-extracted client-side), .txt, or .md — or paste below</small>
        </div>
        {pdfBusy && <div className="status-pill" style={{ marginBottom: '0.5rem' }}>{pdfBusy}</div>}
        <textarea
          rows={12}
          placeholder="Paste your resume here, or upload a PDF above. Behavioral mode grounds STAR answers in this content."
          value={profile.resume_text}
          onChange={profileChange('resume_text')}
        />
        <small>{profile.resume_text.length.toLocaleString()} characters loaded</small>
      </div>

      <div className="field">
        <label>Additional notes</label>
        <textarea
          rows={5}
          placeholder="Anything the LLM should know: strengths, weaknesses, motivations, salary expectations, hobbies, etc."
          value={profile.extra_notes}
          onChange={profileChange('extra_notes')}
        />
      </div>

      {/* ===== LLM provider ========================================= */}
      <h2>LLM provider</h2>
      <div className="row">
        <div className="field" style={{ flex: 1 }}>
          <label>Provider</label>
          <select
            value={settings.provider}
            onChange={(e) => settingsChange('provider', e.target.value as ProviderId)}
          >
            {config?.providers.map((p) => {
              const own = !!settings.api_keys[p.id];
              const flag = p.has_key ? '· server key' : own ? '· your key' : '· no key';
              return <option key={p.id} value={p.id}>{p.id} {flag}</option>;
            })}
            {!config && <option value="openai">openai</option>}
          </select>
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Model (blank = server default)</label>
          <input
            placeholder={config?.providers.find((p) => p.id === settings.provider)?.default_model}
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

      {/* ===== API keys (local) ===================================== */}
      <h2>API keys <small style={{ color: 'var(--muted)' }}>(stored locally in this browser)</small></h2>
      <div className="status-pill warn" style={{ marginBottom: '0.75rem', display: 'block' }}>
        ⚠ Stored unencrypted in localStorage. Anyone with access to this browser
        profile can read them. Use revocable, spend-limited keys. Click <em>Clear</em>
        before lending the device.
      </div>
      {PROVIDER_IDS.map((p) => {
        const placeholder = p === 'openai'    ? 'sk-…'
                          : p === 'anthropic' ? 'sk-ant-…'
                          : p === 'deepseek'  ? 'sk-…'
                          : '…';
        const probeMsg = probe[p];
        return (
          <div className="field" key={p}>
            <label>{p}</label>
            <div className="row">
              <input
                type={keyShow[p] ? 'text' : 'password'}
                autoComplete="off"
                spellCheck={false}
                placeholder={placeholder}
                value={settings.api_keys[p]}
                onChange={(e) => keyChange(p, e.target.value)}
                style={{ flex: 1, fontFamily: 'var(--mono)' }}
              />
              <button className="secondary" type="button"
                onClick={() => setKeyShow({ ...keyShow, [p]: !keyShow[p] })}>
                {keyShow[p] ? 'Hide' : 'Show'}
              </button>
              <button className="secondary" type="button" onClick={() => void testKey(p)}>
                Test
              </button>
              <button className="secondary" type="button"
                onClick={() => keyChange(p, '')}>Clear</button>
            </div>
            {probeMsg && <small>{probeMsg}</small>}
          </div>
        );
      })}
      <div className="row" style={{ marginTop: '0.5rem' }}>
        <button className="danger" type="button" onClick={clearAllKeys}>Clear all keys</button>
        <small style={{ color: 'var(--muted)' }}>
          When a key is set here, the chat uses it instead of the server's env var.
        </small>
      </div>

      {/* ===== Owner token ========================================== */}
      {ownerModeServer && (
        <>
          <h2>Owner token <small style={{ color: 'var(--muted)' }}>(this deployment is locked down)</small></h2>
          <div className={'status-pill ' + (isOwner ? 'ok' : 'warn')}
               style={{ display: 'block', marginBottom: '0.5rem' }}>
            {isOwner
              ? '✓ Recognised as owner — server-side API keys are available to you.'
              : '⚠ Not recognised as owner — you must use your own API keys above. ' +
                'Paste the owner token shared with you to unlock the server keys.'}
          </div>
          <div className="field">
            <label>HYNI_OWNER_TOKEN value</label>
            <div className="row">
              <input
                type={showOwner ? 'text' : 'password'}
                autoComplete="off"
                spellCheck={false}
                placeholder="(paste the token from the server admin)"
                value={settings.owner_token}
                onChange={(e) => settingsChange('owner_token', e.target.value)}
                style={{ flex: 1, fontFamily: 'var(--mono)' }}
              />
              <button className="secondary" type="button"
                onClick={() => setShowOwner((v) => !v)}>
                {showOwner ? 'Hide' : 'Show'}
              </button>
              <button className="secondary" type="button"
                onClick={() => settingsChange('owner_token', '')}>Clear</button>
            </div>
            <small>
              Sent as <code>Authorization: Bearer …</code> on every API call.
              Lets you (or anyone you share it with) use the server's LLM keys.
            </small>
          </div>
        </>
      )}

      {/* ===== Voice ================================================ */}
      <h2>Voice <small style={{ color: 'var(--muted)' }}>(Web Speech API)</small></h2>
      <div className="row">
        <div className="field" style={{ flex: 2 }}>
          <label>Voice ({tts.voices.length} available)</label>
          <select
            value={settings.tts_voice_uri}
            onChange={(e) => settingsChange('tts_voice_uri', e.target.value)}
          >
            <option value="">(engine default)</option>
            {tts.voices.map((v) => (
              <option key={v.id} value={v.id}>{v.label}</option>
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
      <div className="row">
        <div className="field" style={{ flex: 1 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <input
              type="checkbox"
              checked={settings.speak_replies}
              onChange={(e) => settingsChange('speak_replies', e.target.checked)}
              style={{ width: 'auto' }}
            />
            Speak assistant replies aloud
          </label>
        </div>
        <button className="secondary" type="button"
          disabled={tts.isSpeaking || tts.state !== 'ready'}
          onClick={() => void tts.speak(
            "Hello. This is a quick voice preview from your selected voice.",
            { voiceId: settings.tts_voice_uri, rate: settings.tts_rate, pitch: settings.tts_pitch })}>
          ▶ Preview voice
        </button>
      </div>

      {/* ===== Streaming ============================================ */}
      <h2>Response delivery</h2>
      <div className="field">
        <label>
          <input
            type="checkbox"
            checked={settings.stream_replies}
            onChange={(e) => settingsChange('stream_replies', e.target.checked)}
            style={{ width: 'auto', marginRight: '0.5rem' }}
          />
          Stream replies (tokens render as they arrive — snappier perceived latency)
        </label>
      </div>

      {/* ===== Save / Reset ========================================= */}
      <div className="row" style={{ marginTop: '1.5rem' }}>
        <button onClick={save}>Save</button>
        <button className="secondary" onClick={reset}>Reset all</button>
        {saved && <span className="status-pill ok">{saved}</span>}
      </div>
    </div>
  );
}

// Unused-keyboard suppression: keep ApiKeyBag in the type space so future
// consumers can reference it without importing from types separately.
export type _AppApiKeyBag = ApiKeyBag;
