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
  it('orders builds by their stamp, whatever the package version', () => {
    expect(compareBuilds('1.5.2+mvxz8lgu', '1.5.2+mvxrv712')).toBe('newer');
    expect(compareBuilds('1.5.2+mvxrv712', '1.5.2+mvxz8lgu')).toBe('older');
    expect(compareBuilds('1.4.0+mvxz8lgu', '1.5.2+mvxrv712')).toBe('newer');
  });

  it('reports identical versions as the same build', () => {
    expect(compareBuilds('1.5.2+mvxz8lgu', '1.5.2+mvxz8lgu')).toBe('same');
    expect(compareBuilds('1.5.2+unknown', '1.5.2+unknown')).toBe('same');
  });

  it('cannot order a build without a readable stamp', () => {
    expect(compareBuilds('1.5.2+unknown', '1.5.2+mvxz8lgu')).toBe('unknown');
    expect(compareBuilds('1.5.2+mvxz8lgu', '1.5.2')).toBe('unknown');
  });

  it('cannot order two different versions with the same stamp', () => {
    expect(compareBuilds('1.5.3+mvxz8lgu', '1.5.2+mvxz8lgu')).toBe('unknown');
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

  it('tells the user to restart the client otherwise', () => {
    const notice = outdatedRelayNotice('1.5.2+a', '1.5.2+b');
    expect(notice).toContain('1.5.2+a');
    expect(notice).toContain('1.5.2+b');
    expect(notice).toMatch(/restart the client/i);
  });
});
