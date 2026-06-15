import { useState, useCallback } from 'react';
import { api } from '../../lib/api-client';
import { usePolling } from '../../lib/use-polling';
import { TagList } from '../../components/TagList';
import { ConfirmDialog } from '../../components/ConfirmDialog';

interface PrivacyStatus {
  paused?: boolean;
  excludedApps?: string[];
  allowedDeleteRanges?: string[];
}

export function PrivacyPage() {
  const fetcher = useCallback(() => api<PrivacyStatus>('/privacy'), []);
  const { data, refresh } = usePolling(fetcher, 30_000);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  const handlePauseResume = async () => {
    const action = data?.paused ? 'resume' : 'pause';
    await api('/privacy/action', { method: 'POST', body: JSON.stringify({ action }) });
    refresh();
  };

  const handleExcludeApp = async (appName: string) => {
    await api('/privacy/action', { method: 'POST', body: JSON.stringify({ action: 'exclude-app', appName }) });
    refresh();
  };

  const handleDeleteRange = async (range: string) => {
    await api('/privacy/action', { method: 'POST', body: JSON.stringify({ action: 'delete-range', range, confirm: true }) });
    setConfirmDelete(null);
    setMessage(`Deleted range: ${range}`);
    refresh();
  };

  const allowedRanges = (data?.allowedDeleteRanges ?? ['last_1h', 'last_1d', 'all']) as string[];

  return (
    <div>
      <h2 className="text-lg font-semibold mb-4">Privacy Controls</h2>

      {message && <div className="text-xs text-success mb-3">{message}</div>}

      <div className="space-y-4">
        <div className="border border-border rounded-lg p-4 bg-card">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium">Collection</span>
            <button
              onClick={handlePauseResume}
              className={`px-3 py-1.5 text-xs rounded ${data?.paused ? 'bg-success text-background' : 'bg-warning text-background'}`}
            >
              {data?.paused ? 'Resume' : 'Pause'}
            </button>
          </div>
          <div className="text-xs text-muted-foreground">
            Status: {data?.paused ? 'Paused' : 'Active'}
          </div>
        </div>

        <div className="border border-border rounded-lg p-4 bg-card">
          <h3 className="text-sm font-medium mb-2">Excluded Apps</h3>
          <TagList
            tags={data?.excludedApps ?? []}
            onAdd={handleExcludeApp}
            onRemove={() => {
              setMessage('Removing excluded apps is not supported yet. Edit config.yaml directly.');
            }}
          />
        </div>

        <div className="border border-border rounded-lg p-4 bg-card">
          <h3 className="text-sm font-medium mb-2">Delete Data</h3>
          <div className="flex gap-2">
            {allowedRanges.map(range => (
              <button
                key={range}
                onClick={() => setConfirmDelete(range)}
                className="px-3 py-1.5 text-xs rounded bg-destructive/10 text-destructive hover:bg-destructive/20"
              >
                {range}
              </button>
            ))}
          </div>
        </div>
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title="Delete Data"
          message={`Are you sure you want to delete data for range "${confirmDelete}"? This action cannot be undone.`}
          confirmLabel="Delete"
          onConfirm={() => handleDeleteRange(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
