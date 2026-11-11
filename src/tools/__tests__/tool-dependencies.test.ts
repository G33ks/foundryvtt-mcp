import { describe, expect, it } from 'vitest';
import { getAllTools } from '../definitions.js';
import { getAllResources } from '../resources.js';
import {
  needsBridge,
  prefersBridge,
  resourceDependency,
  toolDependency,
  waitsForSocket,
} from '../tool-dependencies.js';
import { isWriteTool } from '../write-tools.js';

const tools = getAllTools().map((tool) => tool.name);

describe('tool dependencies', () => {
  it('classifies every tool definition', () => {
    expect(tools).toHaveLength(115);
    for (const name of tools) {
      expect(toolDependency(name), name).toBeDefined();
    }
  });

  it('classifies every resource', () => {
    for (const { uri } of getAllResources()) {
      expect(resourceDependency(uri), uri).toBeDefined();
    }
    expect(resourceDependency('foundry://actors')).toBe('socket');
    expect(resourceDependency('foundry://system/diagnostics')).toBe('rest');
  });

  it('counts each group as the inventory does', () => {
    const counts: Record<string, number> = {};
    for (const name of tools) {
      const dependency = toolDependency(name) ?? 'none';
      counts[dependency] = (counts[dependency] ?? 0) + 1;
    }
    expect(counts).toEqual({
      socket: 93,
      'socket+bridge': 3,
      bridge: 9,
      rest: 5,
      'rest-or-local': 1,
      local: 3,
      health: 1,
    });
  });

  it('puts every write through the socket or the module', () => {
    for (const name of tools.filter(isWriteTool)) {
      expect(['socket', 'socket+bridge', 'bridge'], name).toContain(toolDependency(name));
    }
  });

  it('makes only socket and mixed tools wait for the socket', () => {
    expect(waitsForSocket(toolDependency('get_users'))).toBe(true);
    expect(waitsForSocket(toolDependency('watch_events'))).toBe(true);
    expect(waitsForSocket(toolDependency('import_compendium_actor'))).toBe(true);
    for (const name of [
      'capture_scene',
      'search_compendium',
      'roll_dice',
      'generate_npc',
      'get_health_status',
    ]) {
      expect(waitsForSocket(toolDependency(name)), name).toBe(false);
    }
    // An unclassified name waits: it may read the cache.
    expect(waitsForSocket(toolDependency('no_such_tool'))).toBe(true);
  });

  it('needs the module for bridge tools and compendium item sources only', () => {
    expect(needsBridge('capture_scene', {})).toBe(true);
    expect(needsBridge('import_compendium_actor', {})).toBe(true);
    expect(needsBridge('get_actor_stats', { actorId: 'a' })).toBe(true);
    expect(needsBridge('create_actor_item', { source: { type: 'compendium' } })).toBe(true);
    expect(needsBridge('create_actor_item', { source: { type: 'inline' } })).toBe(false);
    expect(needsBridge('create_actor_item', {})).toBe(false);
    expect(needsBridge('lookup_rule', {})).toBe(false);
    // Goes through the module when one announcing the command is connected, never waits for it.
    expect(needsBridge('apply_status_effect', { tokenId: 't', statusId: 's' })).toBe(false);
    expect(prefersBridge('apply_status_effect')).toBe(true);
    expect(prefersBridge('create_actor_effect')).toBe(false);
    expect(needsBridge('get_users', {})).toBe(false);
  });
});
