import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import type { FoundryClient, SceneToken } from '../../../foundry/client.js';
import type { FoundryScene, WorldScene } from '../../../foundry/types.js';
import { handleGetSceneInfo, handleListTokens } from '../scenes.js';

const SCENE_ID = 'ssssssssssssssss'; // 16 alphanumeric chars
const OTHER_SCENE_ID = 'oooooooooooooooo';

describe('handleGetSceneInfo — lighting', () => {
  const sceneInfo = async (lighting: Partial<FoundryScene>) => {
    const scene: FoundryScene = {
      _id: SCENE_ID,
      name: 'Test Scene',
      active: true,
      navigation: true,
      width: 1000,
      height: 1000,
      padding: 0.25,
      shiftX: 0,
      shiftY: 0,
      ...lighting,
    };
    const client = {
      getCurrentScene: vi.fn().mockResolvedValue(scene),
    } as unknown as FoundryClient;
    const result = await handleGetSceneInfo({ sceneId: SCENE_ID }, client);
    return result.content[0]?.text ?? '';
  };

  it('shows the darkness and global light read from the cache', async () => {
    const text = await sceneInfo({ darkness: 0.07, globalLight: true });
    expect(text).toContain('**Global Light:** Enabled');
    expect(text).toContain('**Darkness Level:** 7%');
  });

  it('reads environment from a raw document (REST API module)', async () => {
    const text = await sceneInfo({
      environment: { darknessLevel: 0.5, globalLight: { enabled: false } },
    });
    expect(text).toContain('**Global Light:** Disabled');
    expect(text).toContain('**Darkness Level:** 50%');
  });

  it('says Unknown rather than NaN when neither form is there', async () => {
    const text = await sceneInfo({});
    expect(text).toContain('**Global Light:** Unknown');
    expect(text).toContain('**Darkness Level:** Unknown');
    expect(text).not.toContain('NaN');
  });
});

describe('handleListTokens', () => {
  const createMockClient = (opts: {
    scenes?: Array<Pick<WorldScene, '_id' | 'name' | 'active'>>;
    tokens?: SceneToken[];
  }): FoundryClient =>
    ({
      getScenes: vi.fn(() => opts.scenes ?? []),
      listTokens: vi.fn(() => opts.tokens ?? []),
    }) as unknown as FoundryClient;

  const token = (overrides: Partial<SceneToken> = {}): SceneToken => ({
    id: 'tttttttttttttttt',
    name: 'Goblin',
    actorId: 'aaaaaaaaaaaaaaaa',
    actorLink: true,
    x: 100,
    y: 200,
    width: 1,
    height: 1,
    elevation: 0,
    rotation: 0,
    hidden: false,
    disposition: -1,
    ...overrides,
  });

  it('defaults to the active scene when sceneId is omitted', async () => {
    const client = createMockClient({
      scenes: [{ _id: SCENE_ID, name: 'Neon Alley', active: true }],
      tokens: [token()],
    });

    const result = await handleListTokens({}, client);

    expect(client.listTokens).toHaveBeenCalledWith(SCENE_ID);
    expect(result.content[0].text).toContain('Tokens on Neon Alley');
    expect(result.content[0].text).toContain('Goblin');
    expect(result.content[0].text).toContain('(100, 200)');
    expect(result.content[0].text).toContain('hostile');
  });

  it('scopes to an explicit sceneId', async () => {
    const client = createMockClient({
      scenes: [
        { _id: SCENE_ID, name: 'Neon Alley', active: true },
        { _id: OTHER_SCENE_ID, name: 'Rooftop', active: false },
      ],
      tokens: [token({ id: 'r1r1r1r1r1r1r1r1', name: 'Sniper' })],
    });

    const result = await handleListTokens({ sceneId: OTHER_SCENE_ID }, client);

    expect(client.listTokens).toHaveBeenCalledWith(OTHER_SCENE_ID);
    expect(result.content[0].text).toContain('Tokens on Rooftop');
    expect(result.content[0].text).toContain('Sniper');
  });

  it('reports no tokens without erroring on an empty scene', async () => {
    const client = createMockClient({
      scenes: [{ _id: SCENE_ID, name: 'Neon Alley', active: true }],
      tokens: [],
    });

    const result = await handleListTokens({}, client);

    expect(result.content[0].text).toContain('No tokens placed on Neon Alley');
  });

  it('notes an unlinked actor and a hidden token', async () => {
    const client = createMockClient({
      scenes: [{ _id: SCENE_ID, name: 'Neon Alley', active: true }],
      tokens: [token({ actorLink: false, hidden: true })],
    });

    const result = await handleListTokens({}, client);

    expect(result.content[0].text).toContain('(unlinked)');
    expect(result.content[0].text).toContain('[hidden]');
  });

  it('raises McpError when there is no active scene and no sceneId given', async () => {
    const client = createMockClient({ scenes: [] });
    await expect(handleListTokens({}, client)).rejects.toThrow(McpError);
    expect(client.listTokens).not.toHaveBeenCalled();
  });
});
