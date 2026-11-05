/**
 * @fileoverview Ordering connector builds: by package version, then by
 * build stamp.
 *
 * A relay computes its version once, at startup, but starts the shared
 * process from the files on disk — so after a rebuild an old relay can
 * never find a shared process of its own version. If every mismatch
 * restarted the shared process, that relay would restart it over and over.
 * The shared process therefore restarts only for a strictly newer relay:
 * each restart then yields a strictly newer process, which bounds them.
 *
 * The package version decides first: npm stamps each install with the time
 * it was extracted, so a 2.0.0 extracted after a 2.1.0 (npx cache, a second
 * prefix) carries the later stamp. The stamp only orders two builds of the
 * same version, e.g. a clone rebuilt without a version bump.
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

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+.*)?$/;

/** Semver precedence of the package versions of two builds (build stamps ignored), or `null`. */
function compareVersions(a: string, b: string): number | null {
  const ma = SEMVER.exec(a);
  const mb = SEMVER.exec(b);
  if (!ma || !mb) {
    return null;
  }
  for (const i of [1, 2, 3]) {
    const diff = Number(ma[i]) - Number(mb[i]);
    if (diff !== 0) {
      return Math.sign(diff);
    }
  }
  const pa = ma[4];
  const pb = mb[4];
  // A release ranks above its pre-releases.
  if (pa === undefined || pb === undefined) {
    return pa === pb ? 0 : pa === undefined ? 1 : -1;
  }
  const ia = pa.split('.');
  const ib = pb.split('.');
  for (let i = 0; i < Math.min(ia.length, ib.length); i++) {
    const x = ia[i] as string;
    const y = ib[i] as string;
    if (x === y) {
      continue;
    }
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      return Math.sign(Number(x) - Number(y));
    }
    // Numeric identifiers rank below alphanumeric ones.
    if (nx !== ny) {
      return nx ? -1 : 1;
    }
    return x < y ? -1 : 1;
  }
  return Math.sign(ia.length - ib.length);
}

/**
 * How build `a` compares to build `b`: by package version (semver), then,
 * for the same version, by build stamp. `unknown` when a version is not
 * semver, or when two builds of the same version have no readable or
 * distinct stamps: callers must then leave things as they are.
 */
export function compareBuilds(a: string, b: string): BuildOrder {
  if (a === b) {
    return 'same';
  }
  const byVersion = compareVersions(a, b);
  if (byVersion === null) {
    return 'unknown';
  }
  if (byVersion !== 0) {
    return byVersion > 0 ? 'newer' : 'older';
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
