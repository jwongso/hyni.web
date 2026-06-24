import { Link, NavLink, Route, Routes } from 'react-router-dom';
import { ChatPage } from './pages/ChatPage';
import { SettingsPage } from './pages/SettingsPage';
import { BenchmarkPage } from './pages/BenchmarkPage';

export function App() {
  return (
    <div className="app">
      <header className="app__header">
        <Link to="/" className="app__brand">hyni</Link>
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
