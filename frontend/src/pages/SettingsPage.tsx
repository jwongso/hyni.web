import { useEffect, useMemo, useRef, useState } from 'react';
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
  type SttEngineId,
  type TtsEngineId,
  type UserProfile,
} from '../lib/types';
import { createRecognizer, listAdapters } from '../stt/registry';
import { listSpeakers } from '../tts/registry';
import { useSpeaker } from '../tts/useSpeaker';

// Settings page — owns:
//   • Identity context (target role, resume from PDF/text, strengths, ...)
//   • LLM provider + model + sampling
//   • Per-provider local API keys (BYOK) + owner-token for shared deployments
//   • STT engine picker (auto-downloads model on select if needed)
//   • TTS engine picker + voice list + rate/pitch + speak toggle
//   • Response streaming toggle
//
// Everything is persisted to localStorage via `storage`. A "Save" button
// commits the in-memory draft to localStorage; "Reset all" wipes both
// profile and settings back to defaults.
export function SettingsPage() {
  const [profile,  setProfile]   = useState<UserProfile>(() => storage.loadProfile());
  const [settings, setSettings]  = useState<AppSettings>(() => storage.loadSettings());
  const [config,   setConfig]    = useState<ServerConfig | null>(null);
  const [saved,    setSaved]     = useState<string>('');
  const [pdfBusy,  setPdfBusy]   = useState<string>('');
  const [keyShow,  setKeyShow]   = useState<Record<string, boolean>>({});
  const [showOwner, setShowOwner] = useState(false);
  const [probe,    setProbe]     = useState<Record<string, string>>({});
  const [sttDl,    setSttDl]     = useState<string>('');

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

  // ---------------------------------------------------------------------------
  // STT model download — when the user picks a model-needing engine, kick off
  // its init() so the model is fetched + cached in IndexedDB. We never call
  // start(), so no mic permission prompt is triggered.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const meta = listAdapters().find((m) => m.id === settings.stt_engine);
    if (!meta || !meta.capabilities.needsModelDownload) {
      setSttDl('');
      return;
    }
    if (!meta.isAvailable()) {
      setSttDl(`Not available: ${meta.unavailableReason?.() ?? 'unsupported'}`);
      return;
    }
    let cancelled = false;
    const rec = createRecognizer(settings.stt_engine);
    rec.setHandlers({
      onStatus: (_state, msg) => {
        if (cancelled) return;
        if (msg) setSttDl(msg);
      },
      onError: (msg) => { if (!cancelled) setSttDl(`Error: ${msg}`); },
    });
    setSttDl('priming model…');
    rec.init()
      .then(() => { if (!cancelled) setSttDl('Model ready ✓ (cached for offline)'); })
      .catch((e: any) => { if (!cancelled) setSttDl(`Error: ${e?.message ?? e}`); })
      .finally(() => { try { rec.dispose(); } catch { /* ignore */ } });
    return () => { cancelled = true; try { rec.dispose(); } catch { /* ignore */ } };
  }, [settings.stt_engine]);

  // TTS hook — voice list lives here.
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
  const sttMetas        = useMemo(() => listAdapters(), []);
  const ttsMetas        = useMemo(() => listSpeakers(), []);
  const currentStt      = sttMetas.find((m) => m.id === settings.stt_engine);
  const currentTts      = ttsMetas.find((m) => m.id === settings.tts_engine);
  const ownerModeServer = config?.owner_mode_enabled ?? false;
  const isOwner         = config?.is_owner ?? !ownerModeServer;

  // ---------------------------------------------------------------------------
  return (
    <div className="page">
      <h1>Settings</h1>

      {/* ===== Identity context ===================================== */}
      <h2>Identity context <small style={{ color: 'var(--muted)' }}>(injected into every system prompt)</small></h2>

      <div className="field">
        <label>Target role / company</label>
        <input
          placeholder="e.g. Senior Software Engineer at Amazon"
          value={profile.target_role}
          onChange={profileChange('target_role')}
        />
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

      {/* ===== STT engine =========================================== */}
      <h2>Speech-to-Text</h2>
      <div className="field">
        <label>Engine</label>
        <select
          value={settings.stt_engine}
          onChange={(e) => settingsChange('stt_engine', e.target.value as SttEngineId)}
        >
          {sttMetas.map((m) => {
            const ok = m.isAvailable();
            const tag = m.capabilities.offline ? 'local' : 'cloud';
            return (
              <option key={m.id} value={m.id} disabled={!ok}>
                {m.label} · {tag}{ok ? '' : ' — unavailable'}
              </option>
            );
          })}
        </select>
        {currentStt && (
          <small>
            {currentStt.description}
            {currentStt.capabilities.needsModelDownload && (
              <> Model: ~{currentStt.capabilities.modelSizeMb} MB.</>
            )}
          </small>
        )}
        {sttDl && (
          <div className="status-pill" style={{ marginTop: '0.4rem' }}>{sttDl}</div>
        )}
      </div>

      {/* ===== TTS engine =========================================== */}
      <h2>Text-to-Speech</h2>
      <div className="row">
        <div className="field" style={{ flex: 1 }}>
          <label>Engine</label>
          <select
            value={settings.tts_engine}
            onChange={(e) => settingsChange('tts_engine', e.target.value as TtsEngineId)}
          >
            {ttsMetas.map((m) => {
              const ok = m.isAvailable();
              const qual = m.capabilities.voiceQuality;
              return (
                <option key={m.id} value={m.id} disabled={!ok}>
                  {m.label}{qual !== 'system' ? ` · ${qual}` : ''}{ok ? '' : ' — unavailable'}
                </option>
              );
            })}
          </select>
          {currentTts && <small>{currentTts.description}</small>}
        </div>
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
      </div>
      <div className="row">
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
            "Hello. This is a quick voice preview from your selected text-to-speech engine.",
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
