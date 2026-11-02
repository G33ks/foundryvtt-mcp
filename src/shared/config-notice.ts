/**
 * @fileoverview Note appended to a relay's first tool result when the
 * shared process serves it with the configuration it already runs, ignoring
 * some of this relay's own settings ("the file is authoritative", see
 * `mismatchDecision` in daemon.ts).
 */

import type { IgnoredSetting } from './protocol.js';

function origin(source: IgnoredSetting['source']): string {
  switch (source) {
    case 'env':
      return "this client's env block (or the system environment)";
    case '.env':
      return 'the .env file of its working directory';
    case 'file':
      return 'the configuration file';
    case 'default':
      return 'the default value';
  }
}

/** The note text; `null` when nothing is ignored. */
export function ignoredConfigNotice(
  ignored: { settings: IgnoredSetting[]; configFile: string | null } | null,
): string | null {
  if (!ignored) {
    return null;
  }
  const file = ignored.configFile ? ` (${ignored.configFile})` : '';
  const which =
    ignored.settings.length > 0
      ? ignored.settings.map((s) => `${s.name} from ${origin(s.source)}`).join('; ')
      : 'some settings';
  return (
    `ℹ️ This MCP client's own settings are ignored: the shared process serves every client with ` +
    `the configuration it started with${file}, and this client's differ — ${which}. Remove them ` +
    "from this client's env block, or put the same values in the configuration file and run " +
    '`node dist/index.js stop`. `node dist/index.js status` lists the settings of each client.'
  );
}

/** Arms the note once per distinct set of ignored settings; hands it out once. */
export class IgnoredConfigNotice {
  private pending: string | null = null;
  private armedFor: string | null = null;

  connected(ignored: { settings: IgnoredSetting[]; configFile: string | null } | null): void {
    const notice = ignoredConfigNotice(ignored);
    if (notice === null) {
      this.armedFor = null;
      this.pending = null;
      return;
    }
    if (notice !== this.armedFor) {
      this.armedFor = notice;
      this.pending = notice;
    }
  }

  take(): string | null {
    const notice = this.pending;
    this.pending = null;
    return notice;
  }
}
