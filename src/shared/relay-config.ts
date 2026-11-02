/**
 * @fileoverview A relay's view of its configuration.
 *
 * Re-read before each handshake, and before each call while it is unusable:
 * writing the configuration file is enough to make a waiting relay work,
 * and editing it then `stop` is enough to apply a change — no client restart.
 */

import { type Config, configSettings, resetConfig, tryGetConfig } from '../config/index.js';
import { configDigests, configFingerprint } from './config-hash.js';
import type { Hello } from './protocol.js';

export class RelayConfig {
  private lastUsable: Config | null = null;
  private lastProblem: string | null = null;

  /**
   * @param warn - told each new problem once (and the file permission warning)
   */
  constructor(private readonly warn: (message: string) => void = () => undefined) {}

  /** Resolves the configuration again from the environment, `.env` and the file. */
  reload(): { config: Config } | { error: Error } {
    resetConfig();
    const loaded = tryGetConfig();
    if ('config' in loaded) {
      this.lastUsable = loaded.config;
      this.lastProblem = null;
      const { file } = configSettings();
      if (file.warning) {
        this.warn(file.warning);
      }
    } else if (loaded.error.message !== this.lastProblem) {
      this.lastProblem = loaded.error.message;
      this.warn(loaded.error.message);
    }
    return loaded;
  }

  /** The configuration once usable (re-read on every call until then), or why there is none. */
  usable(): Config | Error {
    if (this.lastUsable) {
      return this.lastUsable;
    }
    const loaded = this.reload();
    return 'config' in loaded ? loaded.config : loaded.error;
  }

  /**
   * The configuration part of a handshake, re-read now. Unusable since the
   * last call: the settings that last worked.
   *
   * @throws when there never was a usable configuration (calls check first)
   */
  helloFields(token: string): Pick<Hello, 'configHash' | 'configSources' | 'configDigests'> {
    const loaded = this.reload();
    const config = 'config' in loaded ? loaded.config : this.lastUsable;
    if (!config) {
      throw new Error('no usable configuration');
    }
    return {
      configHash: configFingerprint(config, token),
      configSources: configSettings().sources,
      configDigests: configDigests(config, token),
    };
  }
}
