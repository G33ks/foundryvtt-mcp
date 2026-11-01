import { describe, expect, it } from 'vitest';
import * as definitions from '../definitions.js';
import { isWriteTool, WRITE_TOOLS } from '../write-tools.js';

const allNames = new Set(definitions.getAllTools().map((tool) => tool.name));

describe('write tool classification', () => {
  it('covers every tool of every *MutationTools group (list_walls aside)', () => {
    const groups = Object.entries(definitions).filter(
      ([key, value]) => key.endsWith('MutationTools') && Array.isArray(value),
    );
    expect(groups.length).toBeGreaterThan(5);
    for (const [, group] of groups) {
      for (const { name } of group as Array<{ name: string }>) {
        if (name !== 'list_walls') {
          expect(isWriteTool(name), name).toBe(true);
        }
      }
    }
  });

  it('only names tools that exist', () => {
    for (const name of WRITE_TOOLS) {
      expect(allNames.has(name), name).toBe(true);
    }
  });

  it('leaves reads, including the long-polling watch_events, out of the queue', () => {
    for (const name of ['get_users', 'search_actors', 'list_walls', 'watch_events', 'roll_dice']) {
      expect(isWriteTool(name), name).toBe(false);
    }
  });
});
