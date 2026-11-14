import { describe, expect, it } from 'vitest';
import { readSceneLighting, sceneLightingUpdate } from '../scene-lighting.js';

describe('readSceneLighting', () => {
  it('reads environment (FoundryVTT v12 and later)', () => {
    expect(
      readSceneLighting({
        environment: { darknessLevel: 0.5, globalLight: { enabled: true, darkness: { max: 1 } } },
      }),
    ).toEqual({ darkness: 0.5, globalLight: true });
  });

  it('prefers environment over the older top-level fields', () => {
    expect(
      readSceneLighting({
        environment: { darknessLevel: 0, globalLight: { enabled: false } },
        darkness: 1,
        globalLight: true,
      }),
    ).toEqual({ darkness: 0, globalLight: false });
  });

  it('falls back to the older top-level fields', () => {
    expect(readSceneLighting({ darkness: 0.25, globalLight: true })).toEqual({
      darkness: 0.25,
      globalLight: true,
    });
  });

  it('leaves out what neither form carries', () => {
    expect(readSceneLighting({})).toEqual({});
    expect(readSceneLighting({ environment: { darknessLevel: Number.NaN } })).toEqual({});
  });
});

describe('sceneLightingUpdate', () => {
  it('writes every field under environment', () => {
    expect(
      sceneLightingUpdate({ darkness: 0.5, globalLight: true, globalLightThreshold: 0.75 }),
    ).toEqual({
      environment: {
        darknessLevel: 0.5,
        globalLight: { enabled: true, darkness: { max: 0.75 } },
      },
    });
  });

  it('writes only the fields given', () => {
    expect(sceneLightingUpdate({ globalLight: false })).toEqual({
      environment: { globalLight: { enabled: false } },
    });
    expect(sceneLightingUpdate({ darkness: 0 })).toEqual({ environment: { darknessLevel: 0 } });
    expect(sceneLightingUpdate({})).toEqual({});
  });
});
