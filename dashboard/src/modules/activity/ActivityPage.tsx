import { useState, useCallback } from 'react';
import { api } from '../../lib/api-client';
import { usePolling } from '../../lib/use-polling';
import { TimelineEntry } from '../../components/TimelineEntry';

interface Session {
  appName: string;
  contextLabel?: string;
  startedAt: string;
  endedAt: string;
  activeSeconds: number;
  summary?: string;
}

interface SearchResult {
  extractedText?: string;
  score?: number;
  appName?: string;
  timestamp?: string;
}

export function ActivityPage() {
  const today = new Intl.DateTimeFormat('en-CA').format(new Date());
  const [from, setFrom] = useState(today + 'T00:00:00');
  const [to, setTo] = useState(today + 'T23:59:59');
  const [appFilter, setAppFilter] = useState('');
  const [query, setQuery] = useState('');
  const [searchMode, setSearchMode] = useState<'keyword' | 'semantic' | 'hybrid'>('keyword');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  const sessionFetcher = useCallback(
    () => api<{ sessions?: Session[] }>(`/activity/sessions?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${appFilter ? `&appName=${encodeURIComponent(appFilter)}` : ''}`),
    [from, to, appFilter]
  );
  const { data, loading } = usePolling(sessionFetcher, 60_000);

  const handleSearch = async () => {
    setSearching(true);
    try {
      const result = await api<{ results?: SearchResult[] }>('/activity/search', {
        method: 'POST',
        body: JSON.stringify({ query, mode: searchMode, appName: appFilter || undefined, from, to, limit: 20 })
      });
      setSearchResults(result.results ?? []);
    } catch {
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  };

  return (
    <div>
      <h2 className="text-lg font-semibold mb-4">Activity Browser</h2>

      <div className="flex flex-wrap gap-2 mb-4">
        <input type="datetime-local" value={from} onChange={e => setFrom(e.target.value)}
          className="bg-transparent border border-border rounded px-2 py-1 text-xs" />
        <input type="datetime-local" value={to} onChange={e => setTo(e.target.value)}
          className="bg-transparent border border-border rounded px-2 py-1 text-xs" />
        <input type="text" value={appFilter} onChange={e => setAppFilter(e.target.value)}
          placeholder="App filter..." className="bg-transparent border border-border rounded px-2 py-1 text-xs" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div>
          <h3 className="text-sm font-medium mb-2">Sessions</h3>
          {loading && <div className="text-xs text-muted-foreground">Loading...</div>}
          <div>
            {(data?.sessions ?? []).map((s, i) => (
              <TimelineEntry
                key={i}
                timestamp={formatTime(s.startedAt)}
                title={`${s.appName}${s.contextLabel ? ` — ${s.contextLabel}` : ''}`}
              >
                {s.summary ?? `${s.activeSeconds}s active`}
              </TimelineEntry>
            ))}
            {data?.sessions?.length === 0 && <div className="text-xs text-muted-foreground">No sessions in range.</div>}
          </div>
        </div>

        <div>
          <h3 className="text-sm font-medium mb-2">Search</h3>
          <div className="flex gap-2 mb-3">
            <input
              type="text" value={query} onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
              placeholder="Search query..."
              className="flex-1 bg-transparent border border-border rounded px-2 py-1 text-xs outline-none focus:border-foreground"
            />
            <select value={searchMode} onChange={e => setSearchMode(e.target.value as typeof searchMode)}
              className="bg-background border border-border rounded px-2 py-1 text-xs">
              <option value="keyword">Keyword</option>
              <option value="semantic">Semantic</option>
              <option value="hybrid">Hybrid</option>
            </select>
            <button onClick={handleSearch} disabled={searching}
              className="px-3 py-1 text-xs bg-foreground text-background rounded hover:opacity-90 disabled:opacity-50">
              Search
            </button>
          </div>
          <div>
            {searchResults.map((r, i) => (
              <div key={i} className="text-xs border-b border-border py-2 last:border-0">
                <span className="font-mono text-muted-foreground">{r.appName}</span>
                <span className="text-muted-foreground/50 ml-2">{r.timestamp ? formatTime(r.timestamp) : ''}</span>
                <div className="mt-0.5">{r.extractedText?.slice(0, 120)}</div>
                {r.score !== undefined && <span className="text-muted-foreground/50">score: {r.score.toFixed(3)}</span>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(iso));
  } catch {
    return iso;
  }
}
