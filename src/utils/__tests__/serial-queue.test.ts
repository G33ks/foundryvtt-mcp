import { describe, expect, it } from 'vitest';
import { SerialQueue } from '../serial-queue.js';

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

describe('SerialQueue', () => {
  it('runs tasks one at a time in submission order', async () => {
    const queue = new SerialQueue();
    const events: string[] = [];
    const task = (name: string, ms: number) => async () => {
      events.push(`start ${name}`);
      await tick(ms);
      events.push(`end ${name}`);
      return name;
    };

    const results = await Promise.all([
      queue.run(task('a', 20)),
      queue.run(task('b', 1)),
      queue.run(task('c', 5)),
    ]);

    expect(results).toEqual(['a', 'b', 'c']);
    expect(events).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  it('keeps going after a failed task and reports pending tasks', async () => {
    const queue = new SerialQueue();
    const failing = queue.run(async () => {
      await tick();
      throw new Error('boom');
    });
    const next = queue.run(async () => 'next');
    expect(queue.pending).toBe(2);

    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('next');
    expect(queue.pending).toBe(0);
  });
});
