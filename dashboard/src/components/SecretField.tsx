import { useState } from 'react';

interface SecretFieldProps {
  value: string;
  onReveal?: () => Promise<string>;
}

export function SecretField({ value, onReveal }: SecretFieldProps) {
  const [revealed, setRevealed] = useState(false);
  const [realValue, setRealValue] = useState<string | null>(null);

  const handleToggle = async () => {
    if (revealed) {
      setRevealed(false);
      return;
    }
    if (onReveal && !realValue) {
      const val = await onReveal();
      setRealValue(val);
    }
    setRevealed(true);
  };

  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-sm">{revealed ? (realValue ?? value) : '•••••••'}</span>
      <button
        onClick={handleToggle}
        className="text-xs text-muted-foreground hover:text-foreground"
      >
        {revealed ? 'Hide' : 'Reveal'}
      </button>
    </div>
  );
}
