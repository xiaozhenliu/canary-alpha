import type { FieldProps } from '../types';
import { TagList } from '../../../components/TagList';

export function ArrayField({ path, value }: FieldProps) {
  const items = Array.isArray(value) ? value.map(String) : [];

  return (
    <div className="text-xs text-muted-foreground">
      <TagList tags={items} />
      <p className="mt-1 text-[10px]">Use inline add/remove or config CLI to modify array fields.</p>
    </div>
  );
}
