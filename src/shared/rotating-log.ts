/**
 * @fileoverview Append-only log file rotated by size: `x.log` → `x.log.1` →
 * … → `x.log.<keep>`, the oldest being dropped.
 *
 * Several processes may write the same file (every relay appends to
 * `relay.log`), so the size is read from disk on each write and every file
 * operation tolerates losing a race. Logging never throws.
 */

import { appendFileSync, renameSync, rmSync, statSync } from 'node:fs';

export class RotatingLog {
  constructor(
    readonly file: string,
    private readonly maxBytes = 5 * 1024 * 1024,
    private readonly keep = 3,
  ) {}

  write(line: string): void {
    const text = line.endsWith('\n') ? line : `${line}\n`;
    try {
      if (this.size() + Buffer.byteLength(text) > this.maxBytes) {
        this.rotate();
      }
      appendFileSync(this.file, text);
    } catch {
      // A full disk or a locked file must not take the process down.
    }
  }

  private size(): number {
    try {
      return statSync(this.file).size;
    } catch {
      return 0;
    }
  }

  private rotate(): void {
    rmSync(`${this.file}.${this.keep}`, { force: true });
    for (let i = this.keep - 1; i >= 1; i--) {
      try {
        renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`);
      } catch {
        // missing generation, or another process rotated first
      }
    }
    try {
      renameSync(this.file, `${this.file}.1`);
    } catch {
      // another process rotated first
    }
  }
}
