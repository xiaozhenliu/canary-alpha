import { useState } from 'react';

interface TagListProps {
  tags: string[];
  onAdd?: (tag: string) => void;
  onRemove?: (tag: string) => void;
}

export function TagList({ tags, onAdd, onRemove }: TagListProps) {
  const [input, setInput] = useState('');

  const handleAdd = () => {
    const trimmed = input.trim();
    if (trimmed && onAdd) {
      onAdd(trimmed);
      setInput('');
    }
  };

  return (
    <div>
      <div className="flex flex-wrap gap-1 mb-2">
        {tags.map(tag => (
          <span key={tag} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-muted text-xs font-mono">
            {tag}
            {onRemove && (
              <button onClick={() => onRemove(tag)} className="text-muted-foreground hover:text-foreground">
                &times;
              </button>
            )}
          </span>
        ))}
        {tags.length === 0 && <span className="text-xs text-muted-foreground">(empty)</span>}
      </div>
      {onAdd && (
        <div className="flex gap-1">
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
            placeholder="Add item..."
            className="flex-1 bg-transparent border border-border rounded px-2 py-1 text-xs outline-none focus:border-foreground"
          />
          <button onClick={handleAdd} className="px-2 py-1 text-xs bg-muted rounded hover:bg-accent">
            Add
          </button>
        </div>
      )}
    </div>
  );
}
