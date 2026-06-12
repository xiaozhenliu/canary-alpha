import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Document, parseDocument, YAMLSeq, isScalar, Scalar } from 'yaml';
import { resolveConfigPath } from './paths.js';

export class ConfigFileStore {
  constructor(private readonly filePath: string = resolveConfigPath()) {}

  path(): string {
    return this.filePath;
  }

  // Read into an editable Document; file absent → empty Document. Syntax error → throw (caught by validate).
  async readDocument(): Promise<{ doc: Document; existed: boolean }> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const doc = parseDocument(raw);
      if (doc.errors.length > 0) {
        throw new Error(`Invalid YAML syntax: ${doc.errors[0].message}`);
      }
      return { doc, existed: true };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        return { doc: new Document({}), existed: false };
      }
      throw error;
    }
  }

  getAtPath(doc: Document, path: string[]): unknown {
    // keepScalar=false: scalars are returned as bare JS values; collection nodes are converted to plain arrays/objects via toJSON().
    const node = doc.getIn(path, false);
    if (node != null && typeof (node as { toJSON?: unknown }).toJSON === 'function') {
      return (node as { toJSON: () => unknown }).toJSON();
    }
    return node;
  }

  // Extract a comparable value from a seq item: Scalar nodes return their .value; other nodes are returned as-is (naturally false when compared with a string).
  private nodeValue(n: unknown): unknown {
    return isScalar(n) ? (n as Scalar).value : n;
  }

  // Set scalar in-place, preserving comments; intermediate nodes are created automatically.
  setScalarAtPath(doc: Document, path: string[], value: unknown): void {
    doc.setIn(path, value);
  }

  deleteAtPath(doc: Document, path: string[]): void {
    doc.deleteIn(path);
  }

  // Append to array in-place (YAMLSeq.add), creating an empty seq if absent; returns false when the item already exists (dedup).
  addToSeqAtPath(doc: Document, path: string[], item: string): boolean {
    let seq = doc.getIn(path) as YAMLSeq | undefined;
    if (!(seq instanceof YAMLSeq)) {
      seq = new YAMLSeq();
      doc.setIn(path, seq);
    }
    const existing = seq.items.map((n: unknown) => this.nodeValue(n));
    if (existing.includes(item)) {
      return false;
    }
    seq.add(item);
    return true;
  }

  // Remove from array in-place; returns false when the item is not found.
  removeFromSeqAtPath(doc: Document, path: string[], item: string): boolean {
    const seq = doc.getIn(path) as YAMLSeq | undefined;
    if (!(seq instanceof YAMLSeq)) {
      return false;
    }
    const idx = seq.items.findIndex((n: unknown) => this.nodeValue(n) === item);
    if (idx === -1) {
      return false;
    }
    seq.delete(idx);
    return true;
  }

  // Atomic write: temp file in the same directory + mode 0600 on creation + rename. Creates the directory with mkdir -p if absent.
  async write(doc: Document): Promise<void> {
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `.config.yaml.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
    await writeFile(tmp, doc.toString(), { mode: 0o600 });
    try {
      await rename(tmp, this.filePath);
    } catch (error) {
      await unlink(tmp).catch(() => {});
      throw error;
    }
  }
}
