/**
 * @fileoverview Tests for FoundryClient.createWorldActor, including module flags
 * set at creation.
 */

import { describe, expect, it, vi } from 'vitest';
import { isRecord } from '../../utils/guards.js';
import { FoundryClient } from '../client.js';

const FOLDER_ID = 'ffffffffffffffff';

type SocketEmitMock = (event: string, payload: unknown, cb: (response: unknown) => void) => void;

/** The first entry of a create request's `operation.data`. */
function firstCreated(payload: unknown): Record<string, unknown> | undefined {
  const operation = isRecord(payload) ? payload.operation : undefined;
  const data = isRecord(operation) ? operation.data : undefined;
  const first = Array.isArray(data) ? data[0] : undefined;
  return isRecord(first) ? first : undefined;
}

const buildClient = () => {
  const client = new FoundryClient({ baseUrl: 'http://localhost:30000', writeEnabled: true });
  const emit = vi.fn<SocketEmitMock>((_event, payload, cb) => {
    cb({ result: [{ _id: 'newactor00000000', ...firstCreated(payload) }] });
  });
  Reflect.set(client, 'socket', { connected: true, emit });
  return { client, emit };
};

const createdData = (emit: ReturnType<typeof buildClient>['emit']) =>
  firstCreated(emit.mock.calls[0]?.[1]);

describe('FoundryClient.createWorldActor', () => {
  it('creates a bare actor with only name and type', async () => {
    const { client, emit } = buildClient();
    await client.createWorldActor('Wanderer', 'character');
    expect(createdData(emit)).toEqual({ name: 'Wanderer', type: 'character' });
  });

  it('passes module flags through, keyed by module id', async () => {
    const { client, emit } = buildClient();
    const flags = {
      'example-module': {
        link: { url: 'https://example.com/characters/42', characterId: '42' },
      },
    };
    await client.createWorldActor('Wanderer', 'character', undefined, FOLDER_ID, flags);
    expect(createdData(emit)).toEqual({
      name: 'Wanderer',
      type: 'character',
      folder: FOLDER_ID,
      flags,
    });
  });

  it('rejects flags that are not keyed by module', async () => {
    const { client, emit } = buildClient();
    await expect(
      client.createWorldActor('Wanderer', 'character', undefined, undefined, {
        url: 'https://example.com/characters/42',
      }),
    ).rejects.toThrow(/per-module objects/);
    expect(emit).not.toHaveBeenCalled();
  });
});
