/**
 * @fileoverview Ordering connector builds by their build stamp.
 *
 * A relay computes its version once, at startup, but starts the shared
 * process from the files on disk — so after a rebuild an old relay can
 * never find a shared process of its own version. If every mismatch
 * restarted the shared process, that relay would restart it over and over.
 * The shared process therefore restarts only for a strictly newer relay:
 * each restart then yields a strictly newer process, which bounds them.
 */

export type BuildOrder = 'newer' | 'older' | 'same' | 'unknown';

/** The build stamp of a {@link buildVersion} string (`<version>+<base-36 mtime>`), or `null`. */
export function buildStamp(version: string): number | null {
  const stamp = /\+([0-9a-z]+)$/.exec(version)?.[1];
  if (!stamp || stamp === 'unknown') {
    return null;
  }
  const value = Number.parseInt(stamp, 36);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * How build `a` compares to build `b`. `unknown` when either has no
 * readable stamp, or when two different versions carry the same stamp:
 * callers must then leave things as they are.
 */
export function compareBuilds(a: string, b: string): BuildOrder {
  if (a === b) {
    return 'same';
  }
  const stampA = buildStamp(a);
  const stampB = buildStamp(b);
  if (stampA === null || stampB === null || stampA === stampB) {
    return 'unknown';
  }
  return stampA > stampB ? 'newer' : 'older';
}

/**
 * Relay side of {@link outdatedRelayNotice}: armed by a connection to a
 * shared process of another build, taken by the next tool result. A
 * reconnection to a process of the same build does not arm it again.
 */
export class OutdatedRelayNotice {
  private pending: string | null = null;
  private notifiedFor: string | null = null;

  constructor(private readonly relayVersion: string) {}

  /** Records the build of a new connection; returns the notice when it arms one. */
  connected(serverVersion: string): string | null {
    const notice = outdatedRelayNotice(this.relayVersion, serverVersion);
    if (notice === null || serverVersion === this.notifiedFor) {
      this.pending = null;
      return null;
    }
    this.notifiedFor = serverVersion;
    this.pending = notice;
    return notice;
  }

  /** The notice for this tool result, at most once per arming. */
  take(): string | null {
    const notice = this.pending;
    this.pending = null;
    return notice;
  }
}

/**
 * Notice appended once to a relay's first tool result when the shared
 * process runs another build: the relay keeps working, but its tool list
 * is the one it loaded at startup.
 */
export function outdatedRelayNotice(relayVersion: string, serverVersion: string): string | null {
  if (relayVersion === serverVersion) {
    return null;
  }
  return (
    `ℹ️ This MCP client runs an older connector build (v${relayVersion}) than the shared ` +
    `process (v${serverVersion}). It keeps working, but restart the client (fully quit ` +
    'Claude desktop, or restart Claude Code) to load the current tool list.'
  );
}
