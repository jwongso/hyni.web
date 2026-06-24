import { HashRouter } from 'react-router-dom';
import { App } from './App';
import './styles.css';
// Eager registration of every shipped STT / TTS adapter — must come before
// the App so that listAdapters() / listSpeakers() are populated by the
// time any page renders.
import './stt/init';
import './tts/init';
import React from 'react';
import ReactDOM from 'react-dom/client';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
);
