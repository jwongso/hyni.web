import { Link, NavLink, Route, Routes } from 'react-router-dom';
import { ChatPage } from './pages/ChatPage';
import { SettingsPage } from './pages/SettingsPage';
import { BenchmarkPage } from './pages/BenchmarkPage';

// Inline SVG mark for the header. Same shape as /favicon.svg but with a
// unique gradient id so multiple inlines on a page don't collide.
function HyniMark() {
  return (
    <svg
      className="app__logo"
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="hyni"
    >
      <defs>
        <linearGradient id="hyniBrandBg" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
          <stop offset="0%"   stopColor="#a78bfa" />
          <stop offset="100%" stopColor="#6d28d9" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="14" fill="url(#hyniBrandBg)" />
      <text
        x="32" y="47" fill="#ffffff"
        fontFamily="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Inter, sans-serif"
        fontSize="44" fontWeight={800} textAnchor="middle" letterSpacing={-2}
      >h</text>
      <circle cx="46" cy="14" r="2.4" fill="#ffffff" opacity="0.95" />
      <circle cx="52" cy="20" r="1.9" fill="#ffffff" opacity="0.65" />
      <circle cx="58" cy="26" r="1.4" fill="#ffffff" opacity="0.45" />
    </svg>
  );
}

export function App() {
  return (
    <div className="app">
      <header className="app__header">
        <Link to="/" className="app__brand">
          <HyniMark />
          <span>hyni</span>
        </Link>
        <nav className="app__nav">
          <NavLink to="/"          end className={navClass}>Chat</NavLink>
          <NavLink to="/settings"      className={navClass}>Settings</NavLink>
          <NavLink to="/benchmark"     className={navClass}>STT Benchmark</NavLink>
        </nav>
      </header>
      <main className="app__main">
        <Routes>
          <Route path="/"           element={<ChatPage />} />
          <Route path="/settings"   element={<SettingsPage />} />
          <Route path="/benchmark"  element={<BenchmarkPage />} />
        </Routes>
      </main>
    </div>
  );
}

function navClass({ isActive }: { isActive: boolean }) {
  return isActive ? 'app__nav-link app__nav-link--active' : 'app__nav-link';
}
