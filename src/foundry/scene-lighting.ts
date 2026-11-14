/**
 * @fileoverview A scene's darkness and global light.
 *
 * Since v12, FoundryVTT keeps them under `environment`: `darknessLevel`,
 * `globalLight.enabled` and `globalLight.darkness.max` (the darkness above
 * which the global light goes out). It migrated the top-level `darkness`,
 * `globalLight` and `globalLightThreshold` there when loading a document,
 * and v14 (14.370) drops them from an update. They are read only as a
 * fallback, for a payload that still carries them.
 */

import { isRecord } from '../utils/guards.js';

export interface SceneLighting {
  /** 0 (fully lit) to 1 (pitch black). */
  darkness?: number;
  globalLight?: boolean;
}

export interface SceneLightingChange {
  darkness?: number;
  globalLight?: boolean;
  globalLightThreshold?: number;
}

/** The darkness and global light of a scene, from `environment` or the older fields. */
export function readSceneLighting(scene: {
  environment?: unknown;
  darkness?: unknown;
  globalLight?: unknown;
}): SceneLighting {
  const environment = isRecord(scene.environment) ? scene.environment : {};
  const light = isRecord(environment.globalLight) ? environment.globalLight : {};
  const darkness =
    typeof environment.darknessLevel === 'number' ? environment.darknessLevel : scene.darkness;
  const globalLight = typeof light.enabled === 'boolean' ? light.enabled : scene.globalLight;
  return {
    ...(typeof darkness === 'number' && Number.isFinite(darkness) ? { darkness } : {}),
    ...(typeof globalLight === 'boolean' ? { globalLight } : {}),
  };
}

/** The Scene update fields for a lighting change, under `environment`. */
export function sceneLightingUpdate(change: SceneLightingChange): Record<string, unknown> {
  const globalLight: Record<string, unknown> = {};
  if (change.globalLight !== undefined) {
    globalLight.enabled = change.globalLight;
  }
  if (change.globalLightThreshold !== undefined) {
    globalLight.darkness = { max: change.globalLightThreshold };
  }
  const environment: Record<string, unknown> = {};
  if (change.darkness !== undefined) {
    environment.darknessLevel = change.darkness;
  }
  if (Object.keys(globalLight).length > 0) {
    environment.globalLight = globalLight;
  }
  return Object.keys(environment).length > 0 ? { environment } : {};
}
