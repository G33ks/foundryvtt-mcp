/**
 * @fileoverview Runs async tasks one at a time, in submission order.
 */

export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pendingCount = 0;

  /** Tasks submitted and not yet settled, the running one included. */
  get pending(): number {
    return this.pendingCount;
  }

  /** Runs `task` after every previously submitted task has settled. */
  run<T>(task: () => Promise<T>): Promise<T> {
    this.pendingCount++;
    const result = this.tail.then(task).finally(() => {
      this.pendingCount--;
    });
    // A failed task must not block the ones queued behind it.
    this.tail = result.catch(() => undefined);
    return result;
  }
}
