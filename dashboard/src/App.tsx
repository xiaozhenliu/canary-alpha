import { Routes, Route, NavLink } from 'react-router';
import { modules } from './modules/registry';
import { TokenGate } from './components/TokenGate';
import { StatusPage } from './modules/status/StatusPage';

export function App() {
  return (
    <TokenGate>
      <div className="flex h-screen bg-background text-foreground">
        <nav className="w-56 border-r border-border flex flex-col p-4 gap-1">
          <h1 className="text-sm font-semibold tracking-tight mb-4 font-mono">
            computer-history-mcp
          </h1>
          {modules.map((mod) => (
            <NavLink
              key={mod.id}
              to={mod.route}
              className={({ isActive }) =>
                `flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors ${
                  isActive
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                }`
              }
            >
              <span className="text-base">{mod.icon}</span>
              {mod.label}
            </NavLink>
          ))}
        </nav>
        <main className="flex-1 overflow-auto p-6">
          <Routes>
            {modules.map((mod) => (
              <Route key={mod.id} path={mod.route} element={<mod.component />} />
            ))}
            <Route path="*" element={<StatusPage />} />
          </Routes>
        </main>
      </div>
    </TokenGate>
  );
}
