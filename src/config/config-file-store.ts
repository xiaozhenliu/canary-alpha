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

  // 读为可编辑 Document；文件不存在 → 空 Document。语法错误 → 抛出（validate 捕获）。
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
    // keepScalar=false：标量直接返回裸 JS 值；集合节点用 toJSON() 转为普通数组/对象。
    const node = doc.getIn(path, false);
    if (node != null && typeof (node as { toJSON?: unknown }).toJSON === 'function') {
      return (node as { toJSON: () => unknown }).toJSON();
    }
    return node;
  }

  // 取 seq 条目的可比较值：Scalar 节点取其 value，其它节点原样返回（与字符串比较自然为 false）。
  private nodeValue(n: unknown): unknown {
    return isScalar(n) ? (n as Scalar).value : n;
  }

  // 标量就地赋值，保留注释；中间节点自动创建。
  setScalarAtPath(doc: Document, path: string[], value: unknown): void {
    doc.setIn(path, value);
  }

  deleteAtPath(doc: Document, path: string[]): void {
    doc.deleteIn(path);
  }

  // 数组就地追加（YAMLSeq.add），不存在则创建空 seq；返回 false 表示已存在（去重）。
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

  // 数组就地移除；返回 false 表示未找到。
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

  // 原子写：同目录临时文件 + 创建时 0600 + rename。目录不存在则 mkdir -p。
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
