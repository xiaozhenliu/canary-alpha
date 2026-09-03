import { useState, useCallback } from 'react';
import { api } from '../../lib/api-client';
import { usePolling } from '../../lib/use-polling';
import { RoutineHistory } from './RoutineHistory';

interface RoutineDefinition {
  name: string;
  schedule: string;
  enabled: boolean;
  prompt: string;
  recentActivityMinutes: number;
  createdAt: string;
  updatedAt: string;
  latestRun?: { runId: string; status: string; summary?: string; timestamp: string } | null;
}

const CRON_PRESETS = [
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Daily 8:00', value: '0 8 * * *' },
  { label: 'Daily 18:00', value: '0 18 * * *' },
  { label: 'Weekdays 9:00', value: '0 9 * * 1-5' },
];

interface RoutineForm {
  name: string;
  prompt: string;
  schedule: string;
  recentActivityMinutes: string;
}

const EMPTY_FORM: RoutineForm = {
  name: '',
  prompt: '',
  schedule: '0 8 * * *',
  recentActivityMinutes: ''
};

export function RoutinesPage() {
  const fetcher = useCallback(() => api<{ routines: RoutineDefinition[] }>('/routines'), []);
  const { data, refresh } = usePolling(fetcher, 60_000);
  const [editing, setEditing] = useState<RoutineDefinition | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [historyName, setHistoryName] = useState<string | null>(null);
  const [form, setForm] = useState<RoutineForm>(EMPTY_FORM);
  const [message, setMessage] = useState('');

  const handleCreate = async () => {
    const explicitLookback = form.recentActivityMinutes.trim();
    const recentActivityMinutes = explicitLookback === ''
      ? undefined
      : Number(explicitLookback);

    if (recentActivityMinutes !== undefined && (!Number.isInteger(recentActivityMinutes) || recentActivityMinutes <= 0)) {
      setMessage('Look-back must be a positive whole number or left blank for automatic inference.');
      return;
    }

    try {
      await api('/routines', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          prompt: form.prompt,
          schedule: form.schedule,
          enabled: editing?.enabled ?? true,
          ...(recentActivityMinutes === undefined ? {} : { recentActivityMinutes })
        })
      });
      setMessage(editing ? 'Routine updated' : 'Routine created');
      setShowForm(false);
      setEditing(null);
      setForm(EMPTY_FORM);
      refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Failed');
    }
  };

  const handleToggle = async (routine: RoutineDefinition) => {
    await api('/routines', {
      method: 'POST',
      body: JSON.stringify({
        name: routine.name,
        prompt: routine.prompt,
      schedule: routine.schedule,
      enabled: !routine.enabled,
      recentActivityMinutes: routine.recentActivityMinutes,
      })
    });
    refresh();
  };

  const handleEdit = (routine: RoutineDefinition) => {
    setEditing(routine);
    setForm({
      name: routine.name,
      prompt: routine.prompt,
      schedule: routine.schedule,
      recentActivityMinutes: String(routine.recentActivityMinutes),
    });
    setShowForm(true);
  };

  if (historyName) {
    return (
      <div>
        <button onClick={() => setHistoryName(null)} className="text-xs text-muted-foreground hover:text-foreground mb-4">
          &larr; Back to routines
        </button>
        <RoutineHistory name={historyName} />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Routines</h2>
        <button
          onClick={() => { setShowForm(!showForm); setEditing(null); setForm(EMPTY_FORM); }}
          className="text-xs px-3 py-1.5 bg-foreground text-background rounded hover:opacity-90"
        >
          {showForm ? 'Cancel' : 'New Routine'}
        </button>
      </div>

      {message && <div className="text-xs text-success mb-3">{message}</div>}

      {showForm && (
        <div className="border border-border rounded-lg p-4 mb-4 bg-card space-y-3">
          <h3 className="text-sm font-medium">{editing ? 'Edit Routine' : 'Create Routine'}</h3>
          <input
            type="text"
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder="Routine name"
            disabled={!!editing}
            className="w-full bg-transparent border border-border rounded px-2 py-1 text-sm outline-none focus:border-foreground disabled:opacity-50"
          />
          <textarea
            value={form.prompt}
            onChange={e => setForm(f => ({ ...f, prompt: e.target.value }))}
            placeholder="Prompt..."
            rows={3}
            className="w-full bg-transparent border border-border rounded px-2 py-1 text-sm outline-none focus:border-foreground resize-none"
          />
          <div className="flex gap-2">
            <select
              value={CRON_PRESETS.find(p => p.value === form.schedule) ? form.schedule : ''}
              onChange={e => e.target.value && setForm(f => ({ ...f, schedule: e.target.value }))}
              className="bg-background border border-border rounded px-2 py-1 text-sm"
            >
              <option value="">Custom...</option>
              {CRON_PRESETS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
            <input
              type="text"
              value={form.schedule}
              onChange={e => setForm(f => ({ ...f, schedule: e.target.value }))}
              placeholder="Cron expression"
              className="flex-1 bg-transparent border border-border rounded px-2 py-1 text-sm outline-none focus:border-foreground font-mono"
            />
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="routine-lookback" className="text-xs text-muted-foreground">Look-back (min):</label>
            <input
              id="routine-lookback"
              type="number"
              min="1"
              step="1"
              value={form.recentActivityMinutes}
              onChange={e => setForm(f => ({ ...f, recentActivityMinutes: e.target.value }))}
              placeholder="Auto"
              aria-describedby="routine-lookback-help"
              className="w-20 bg-transparent border border-border rounded px-2 py-1 text-sm outline-none focus:border-foreground"
            />
            <span id="routine-lookback-help" className="text-xs text-muted-foreground">Blank infers from the schedule.</span>
          </div>
          <button onClick={handleCreate} className="px-3 py-1.5 text-xs bg-foreground text-background rounded hover:opacity-90">
            {editing ? 'Update' : 'Create'}
          </button>
        </div>
      )}

      <div className="space-y-2">
        {data?.routines.map(r => (
          <div key={r.name} className="border border-border rounded-lg p-3 bg-card">
            <div className="flex items-center justify-between">
              <button onClick={() => handleEdit(r)} className="text-sm font-mono hover:underline">{r.name}</button>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setHistoryName(r.name)}
                  className="text-[10px] text-muted-foreground hover:text-foreground"
                >
                  history
                </button>
                <button
                  onClick={() => handleToggle(r)}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${r.enabled ? 'bg-success' : 'bg-muted'}`}
                  title={r.enabled ? 'Disable' : 'Enable'}
                >
                  <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${r.enabled ? 'translate-x-4.5' : 'translate-x-0.5'}`} />
                </button>
              </div>
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              <span className="font-mono">{r.schedule}</span>
              <span className="ml-2">Look-back: {r.recentActivityMinutes} min</span>
              {r.latestRun && (
                <span className="ml-2">
                  Last: <span className={r.latestRun.status === 'success' ? 'text-success' : 'text-destructive'}>{r.latestRun.status}</span>
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-2 whitespace-pre-wrap">{r.prompt}</p>
          </div>
        ))}
        {data?.routines.length === 0 && <div className="text-xs text-muted-foreground">No routines configured.</div>}
      </div>
    </div>
  );
}
