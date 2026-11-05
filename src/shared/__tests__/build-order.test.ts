import { describe, expect, it } from 'vitest';
import {
  buildStamp,
  compareBuilds,
  OutdatedRelayNotice,
  outdatedRelayNotice,
} from '../build-order.js';

describe('buildStamp', () => {
  it('reads the base-36 build stamp after the "+"', () => {
    expect(buildStamp('1.5.2+mvxz8lgu')).toBe(Number.parseInt('mvxz8lgu', 36));
  });

  it.each(['1.5.2', '1.5.2+unknown', '1.5.2+', '1.5.2+zz!', ''])(
    'returns null for %j',
    (version) => {
      expect(buildStamp(version)).toBeNull();
    },
  );
});

describe('compareBuilds', () => {
  it('orders different package versions by version, whatever their stamps', () => {
    // 2.0.0 installed (npx cache, second global prefix) after 2.1.0.
    expect(compareBuilds('2.0.0+mvxz8lgu', '2.1.0+mvxrv712')).toBe('older');
    expect(compareBuilds('2.1.0+mvxrv712', '2.0.0+mvxz8lgu')).toBe('newer');
    expect(compareBuilds('1.10.0+a', '1.9.9+b')).toBe('newer');
    expect(compareBuilds('2.0.0+a', '1.99.99+b')).toBe('newer');
    expect(compareBuilds('0.0.0-unknown+a', '1.5.2+b')).toBe('older');
  });

  it('orders builds of the same version by their stamp', () => {
    expect(compareBuilds('1.5.2+mvxz8lgu', '1.5.2+mvxrv712')).toBe('newer');
    expect(compareBuilds('1.5.2+mvxrv712', '1.5.2+mvxz8lgu')).toBe('older');
  });

  it('ranks a pre-release below its release and pre-releases among themselves', () => {
    expect(compareBuilds('2.0.0-rc.1+z', '2.0.0+a')).toBe('older');
    expect(compareBuilds('2.0.0+a', '2.0.0-rc.1+z')).toBe('newer');
    expect(compareBuilds('2.0.0-rc.2+a', '2.0.0-rc.1+z')).toBe('newer');
    expect(compareBuilds('2.0.0-rc.10+a', '2.0.0-rc.9+z')).toBe('newer');
    expect(compareBuilds('2.0.0-alpha+z', '2.0.0-alpha.1+a')).toBe('older');
    expect(compareBuilds('2.0.0-1+z', '2.0.0-alpha+a')).toBe('older');
    expect(compareBuilds('2.0.0-rc.1+a', '1.9.0+z')).toBe('newer');
  });

  it('orders builds of the same pre-release by their stamp', () => {
    expect(compareBuilds('2.0.0-rc.1+b', '2.0.0-rc.1+a')).toBe('newer');
  });

  it('reports identical versions as the same build', () => {
    expect(compareBuilds('1.5.2+mvxz8lgu', '1.5.2+mvxz8lgu')).toBe('same');
    expect(compareBuilds('1.5.2+unknown', '1.5.2+unknown')).toBe('same');
  });

  it('cannot order builds of the same version without a readable stamp', () => {
    expect(compareBuilds('1.5.2+unknown', '1.5.2+mvxz8lgu')).toBe('unknown');
    expect(compareBuilds('1.5.2+mvxz8lgu', '1.5.2')).toBe('unknown');
  });

  it('orders different versions even without a readable or distinct stamp', () => {
    expect(compareBuilds('1.5.3+unknown', '1.5.2+mvxz8lgu')).toBe('newer');
    expect(compareBuilds('1.5.3+mvxz8lgu', '1.5.2+mvxz8lgu')).toBe('newer');
  });

  it('cannot order a version that is not semver', () => {
    expect(compareBuilds('garbage+b', '1.5.2+a')).toBe('unknown');
    expect(compareBuilds('1.5+b', '1.5.2+a')).toBe('unknown');
  });
});

describe('OutdatedRelayNotice', () => {
  it('stays silent while the shared process runs the relay build', () => {
    const notice = new OutdatedRelayNotice('1.0.0+a');
    expect(notice.connected('1.0.0+a')).toBeNull();
    expect(notice.take()).toBeNull();
  });

  it('hands the notice to one tool result only', () => {
    const notice = new OutdatedRelayNotice('1.0.0+a');
    expect(notice.connected('1.0.0+b')).toMatch(/restart the client/i);
    expect(notice.take()).toMatch(/restart the client/i);
    expect(notice.take()).toBeNull();
  });

  it('does not repeat itself on a reconnection to the same build, but does for a newer one', () => {
    const notice = new OutdatedRelayNotice('1.0.0+a');
    notice.connected('1.0.0+b');
    notice.take();
    expect(notice.connected('1.0.0+b')).toBeNull();
    expect(notice.take()).toBeNull();
    expect(notice.connected('1.0.0+c')).not.toBeNull();
    expect(notice.take()).toContain('1.0.0+c');
  });
});

describe('outdatedRelayNotice', () => {
  it('is null when the relay runs the shared process build', () => {
    expect(outdatedRelayNotice('1.5.2+b', '1.5.2+b')).toBeNull();
  });

  it('calls the relay the older build exactly when the shared process keeps it', () => {
    // The shared process serves a relay unless it is strictly newer
    // (mismatchDecision), so a served relay of another build is older.
    const relay = '2.0.0+zzzzzzzz';
    const server = '2.1.0+aaaaaaaa';
    expect(compareBuilds(relay, server)).toBe('older');
    expect(outdatedRelayNotice(relay, server)).toMatch(
      /older connector build \(v2\.0\.0\+zzzzzzzz\)/,
    );
  });

  it('tells the user to restart the client otherwise', () => {
    const notice = outdatedRelayNotice('1.5.2+a', '1.5.2+b');
    expect(notice).toContain('1.5.2+a');
    expect(notice).toContain('1.5.2+b');
    expect(notice).toMatch(/restart the client/i);
  });
});
