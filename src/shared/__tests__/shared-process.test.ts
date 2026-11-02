import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoreStatus } from '../../core.js';
import { RefusedError } from '../../utils/refusal.js';
import {
  mismatchDecision,
  type SharedCore,
  SharedProcess,
  type SharedProcessOptions,
} from '../daemon.js';
import { DaemonLink } from '../daemon-link.js';
import { IpcConnection } from '../ipc-client.js';
import type { SharedPaths } from '../paths.js';
import { DaemonStatusSchema, type Hello, PROTOCOL_VERSION } from '../protocol.js';
import { readStateFile } from '../state-file.js';

const TOKEN = 'c'.repeat(64);

function makePaths(): SharedPaths {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'fvtt-mcp-daemon-'));
  dirs.push(stateDir);
  const tag = `fvtt-mcp-test-${process.pid}-${randomBytes(4).toString('hex')}`;
  return {
    stateDir,
    endpoint:
      process.platform === 'win32' ? `\\\\.\\pipe\\${tag}` : path.join(stateDir, 'daemon.sock'),
    tokenFile: path.join(stateDir, 'token'),
    stateFile: path.join(stateDir, 'daemon.json'),
    daemonLog: path.join(stateDir, 'daemon.log'),
    relayLog: path.join(stateDir, 'relay.log'),
  };
}

const STATUS: CoreStatus = {
  foundryConnected: true,
  bridge: {
    enabled: true,
    port: 31415,
    moduleConnected: true,
    protocol: 1,
    origin: 'http://localhost:30000',
    moduleConnectedSince: '2026-11-01T00:00:00.000Z',
    state: 'listening',
    error: null,
  },
  headlessGm: { enabled: true, active: true, status: 'ok', launchError: null, state: 'running' },
  writeQueue: 0,
};

function fakeCore(overrides: Partial<SharedCore> = {}): SharedCore {
  return {
    start: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    callTool: vi.fn(
      async (name: string): Promise<CallToolResult> => ({
        content: [{ type: 'text', text: `called ${name}` }],
      }),
    ),
    readResource: vi.fn(async (uri: string) => ({ contents: [{ uri, text: 'r' }] })),
    status: () => STATUS,
    ...overrides,
  };
}

const dirs: string[] = [];
const processes: SharedProcess[] = [];
const links: DaemonLink[] = [];

function makeProcess(
  paths: SharedPaths,
  overrides: Partial<SharedProcessOptions> = {},
): { shared: SharedProcess; exit: ReturnType<typeof vi.fn> } {
  const exit = vi.fn();
  const shared = new SharedProcess({
    paths,
    version: '1.0.0',
    token: TOKEN,
    configHash: 'cfg',
    createCore: async () => fakeCore(),
    exit,
    shutdownGraceMs: 1000,
    ...overrides,
  });
  processes.push(shared);
  return { shared, exit };
}

function hello(overrides: Partial<Hello> = {}): Hello {
  return {
    type: 'hello',
    protocol: PROTOCOL_VERSION,
    role: 'relay',
    version: '1.0.0',
    configHash: 'cfg',
    token: TOKEN,
    ...overrides,
  };
}

function makeLink(paths: SharedPaths, spawnDaemon: () => void, overrides: Partial<Hello> = {}) {
  const link = new DaemonLink({
    endpoint: paths.endpoint,
    logFile: paths.daemonLog,
    hello: () => hello(overrides),
    spawnDaemon,
    readyTimeoutMs: 5000,
    drainTimeoutMs: 5000,
  });
  links.push(link);
  return link;
}

afterEach(async () => {
  for (const link of links.splice(0)) {
    link.close();
  }
  await Promise.all(processes.splice(0).map((p) => p.drainAndExit('test cleanup')));
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('SharedProcess', () => {
  it('serves tool calls and reports its status to control connections', async () => {
    const paths = makePaths();
    const { shared } = makeProcess(paths);
    expect(await shared.start()).toBe('listening');
    expect(readStateFile(paths.stateFile)).toMatchObject({
      pid: process.pid,
      version: '1.0.0',
      endpoint: paths.endpoint,
    });

    const link = makeLink(paths, () => {});
    await expect(link.call('tool', 'get_users', {})).resolves.toMatchObject({
      content: [{ text: 'called get_users' }],
    });

    const control = await IpcConnection.connect(
      paths.endpoint,
      hello({ role: 'control', version: 'x', configHash: '' }),
    );
    const status = DaemonStatusSchema.parse(await control.request('status'));
    control.close();
    expect(status).toMatchObject({
      pid: process.pid,
      version: '1.0.0',
      relays: 1,
      inFlight: 0,
      foundryConnected: true,
      bridge: { enabled: true, moduleConnected: true, protocol: 1 },
    });
  });

  it('holds tool calls until the FoundryVTT connection is up', async () => {
    const paths = makePaths();
    let connected!: () => void;
    const core = fakeCore({
      start: () =>
        new Promise<void>((resolve) => {
          connected = resolve;
        }),
    });
    const { shared } = makeProcess(paths, { createCore: async () => core });
    await shared.start();

    const call = makeLink(paths, () => {}).call('tool', 'search_actors');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(core.callTool).not.toHaveBeenCalled();
    connected();
    await expect(call).resolves.toMatchObject({ content: [{ text: 'called search_actors' }] });
  });

  it('on a failed FoundryVTT connection: explains it, stays up, retries on the next call', async () => {
    const paths = makePaths();
    const start = vi
      .fn<() => Promise<void>>()
      // Warm-up at startup, then the retry made by the first call.
      .mockRejectedValueOnce(new Error('ECONNREFUSED 127.0.0.1:30000'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED 127.0.0.1:30000'))
      .mockResolvedValue(undefined);
    const createCore = vi.fn(async () => fakeCore({ start }));
    const { shared, exit } = makeProcess(paths, { createCore });
    await shared.start();

    const link = makeLink(paths, () => {});
    await expect(link.call('tool', 'x')).rejects.toThrow(
      /could not connect to FoundryVTT: ECONNREFUSED.*next call retries/,
    );
    expect(exit).not.toHaveBeenCalled();

    await expect(link.call('tool', 'y')).resolves.toMatchObject({
      content: [{ text: 'called y' }],
    });
    expect(createCore).toHaveBeenCalledTimes(3);
  });

  it('with no world launched: says so in calls and status, then works once it is launched', async () => {
    const paths = makePaths();
    const noWorld = new RefusedError(
      'No active world on FoundryVTT: launch it from the Setup screen.',
    );
    const start = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(noWorld)
      .mockRejectedValueOnce(noWorld)
      .mockResolvedValue(undefined);
    const { shared } = makeProcess(paths, { createCore: async () => fakeCore({ start }) });
    await shared.start();

    const link = makeLink(paths, () => {});
    const error = await link.call('tool', 'x').catch((e: unknown) => e);
    expect(String(error)).toContain(
      'could not connect to FoundryVTT: No active world on FoundryVTT: launch it from the Setup screen. The next call retries',
    );

    const control = await IpcConnection.connect(paths.endpoint, hello({ role: 'control' }));
    const status = DaemonStatusSchema.parse(await control.request('status'));
    control.close();
    expect(status.startupError).toBe(
      'No active world on FoundryVTT: launch it from the Setup screen.',
    );

    // The GM launches the world: the next call connects.
    await expect(link.call('tool', 'y')).resolves.toMatchObject({
      content: [{ text: 'called y' }],
    });
  });

  it('a second process on the same endpoint stops without building a core', async () => {
    const paths = makePaths();
    await makeProcess(paths).shared.start();
    const createCore = vi.fn(async () => fakeCore());
    const { shared } = makeProcess(paths, { createCore });
    expect(await shared.start()).toBe('in-use');
    expect(createCore).not.toHaveBeenCalled();
  });

  it('stop: finishes, tears down the core, removes the state file, exits 0', async () => {
    const paths = makePaths();
    const core = fakeCore();
    const { shared, exit } = makeProcess(paths, { createCore: async () => core });
    await shared.start();
    await makeLink(paths, () => {}).call('tool', 'warm-up');

    const control = await IpcConnection.connect(paths.endpoint, hello({ role: 'control' }));
    await expect(control.request('stop')).resolves.toEqual({ stopping: true, pid: process.pid });
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(core.shutdown).toHaveBeenCalled();
    expect(existsSync(paths.stateFile)).toBe(false);
  });

  it('a relay with the changed file config: the running call completes, then a new process takes over', async () => {
    const paths = makePaths();
    let finishWrite!: () => void;
    const oldCore = fakeCore({
      callTool: vi.fn(
        () =>
          new Promise<CallToolResult>((resolve) => {
            finishWrite = () => resolve({ content: [{ type: 'text', text: 'written' }] });
          }),
      ),
    });
    // The configuration file now holds the relay's settings.
    const old = makeProcess(paths, {
      createCore: async () => oldCore,
      fileConfigHash: () => 'new-cfg',
    });
    await old.shared.start();
    const write = makeLink(paths, () => {}).call('tool', 'create_scene');
    await vi.waitFor(() => expect(oldCore.callTool).toHaveBeenCalled());

    // A relay with a new configuration knocks; it must spawn the replacement.
    const spawn = vi.fn(() => {
      void makeProcess(paths, { configHash: 'new-cfg' }).shared.start();
    });
    const next = makeLink(paths, spawn, { configHash: 'new-cfg' }).call('tool', 'get_users');

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(old.exit).not.toHaveBeenCalled(); // still draining the write
    finishWrite();
    await expect(write).resolves.toMatchObject({ content: [{ text: 'written' }] });
    await expect(next).resolves.toMatchObject({ content: [{ text: 'called get_users' }] });
    expect(old.exit).toHaveBeenCalledWith(0);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('a relay from an older build is served, never restarts the process, and shows in status', async () => {
    // The post-build loop: a relay started before a build only ever spawns
    // processes of the newer build, which it used to stop one after another.
    const paths = makePaths();
    const current = makeProcess(paths, { version: '1.0.0+b' });
    await current.shared.start();
    const spawn = vi.fn(() => {
      void makeProcess(paths, { version: '1.0.0+b' }).shared.start();
    });

    const stale = makeLink(paths, spawn, { version: '1.0.0+a' });
    await expect(stale.call('tool', 'get_users')).resolves.toMatchObject({
      content: [{ text: 'called get_users' }],
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(current.exit).not.toHaveBeenCalled();

    const control = await IpcConnection.connect(paths.endpoint, hello({ role: 'control' }));
    const status = DaemonStatusSchema.parse(await control.request('status'));
    control.close();
    expect(status).toMatchObject({ relays: 1, outdatedRelays: ['1.0.0+a'] });
  });

  it('a relay whose build cannot be ordered is served without a restart', async () => {
    const paths = makePaths();
    const current = makeProcess(paths, { version: '1.0.0+b' });
    await current.shared.start();
    const link = makeLink(paths, () => {}, { version: '1.0.0+unknown' });
    await expect(link.call('tool', 'get_users')).resolves.toBeDefined();
    expect(current.exit).not.toHaveBeenCalled();
  });

  it('a relay from a newer build replaces the process once', async () => {
    const paths = makePaths();
    const old = makeProcess(paths, { version: '1.0.0+a' });
    await old.shared.start();
    const spawn = vi.fn(() => {
      void makeProcess(paths, { version: '1.0.0+b' }).shared.start();
    });
    const next = makeLink(paths, spawn, { version: '1.0.0+b' });
    await expect(next.call('tool', 'get_users')).resolves.toBeDefined();
    expect(old.exit).toHaveBeenCalledWith(0);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe('idle timeout', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('exits when no relay has been connected for the timeout', async () => {
    const paths = makePaths();
    const { shared, exit } = makeProcess(paths, { idleTimeoutMs: 100 });
    await shared.start();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });

  it('stays up while a relay is connected, however long without calls', async () => {
    const paths = makePaths();
    const { shared, exit } = makeProcess(paths, { idleTimeoutMs: 150 });
    await shared.start();
    const link = makeLink(paths, () => {});
    await link.ensureConnected();

    await sleep(400);
    expect(exit).not.toHaveBeenCalled();

    link.close();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });

  it('never exits on idle with a timeout of 0', async () => {
    const paths = makePaths();
    const { shared, exit } = makeProcess(paths, { idleTimeoutMs: 0 });
    await shared.start();
    await sleep(200);
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('autostart with concurrent relays', () => {
  it('five relays racing to start the shared process end up with one', async () => {
    const paths = makePaths();
    const createCore = vi.fn(async () => fakeCore());
    const outcomes: Array<Promise<'listening' | 'in-use'>> = [];
    const spawn = () => {
      outcomes.push(makeProcess(paths, { createCore }).shared.start());
    };

    const relays = Array.from({ length: 5 }, () => makeLink(paths, spawn));
    const results = await Promise.all(relays.map((link, i) => link.call('tool', `t${i}`)));

    expect(results).toHaveLength(5);
    const settled = await Promise.all(outcomes);
    expect(settled.filter((o) => o === 'listening')).toHaveLength(1);
    expect(createCore).toHaveBeenCalledTimes(1);
  });
});

describe('mismatchDecision', () => {
  it('restarts for a strictly newer build only', () => {
    expect(mismatchDecision('version', '1.0.0+b', '1.0.0+a')).toBe('restart');
    expect(mismatchDecision('version', '1.0.0+a', '1.0.0+b')).toBe('accept');
  });

  it('restarts when the relay has the settings of the file as it is now', () => {
    expect(
      mismatchDecision('config', '1', '1', { relayHash: 'F', ownHash: 'ENV', fileHash: 'F' }),
    ).toBe('restart');
  });

  it("serves any other difference with the process's own settings", () => {
    expect(
      mismatchDecision('config', '1', '1', { relayHash: 'ENV', ownHash: 'F', fileHash: 'F' }),
    ).toBe('accept');
    expect(
      mismatchDecision('config', '1', '1', { relayHash: 'A', ownHash: 'B', fileHash: 'F' }),
    ).toBe('accept');
  });

  it('never restarts while the file is unreadable or invalid', () => {
    expect(
      mismatchDecision('config', '1', '1', { relayHash: 'F', ownHash: 'ENV', fileHash: null }),
    ).toBe('accept');
  });
});

describe('the configuration file is authoritative', () => {
  it('serves a relay with its own env block, tells it which settings are ignored, and lists it', async () => {
    const paths = makePaths();
    const current = makeProcess(paths, {
      configHash: 'F',
      configDigests: { FOUNDRY_URL: 'u', FOUNDRY_WRITE_ENABLED: 'w-false' },
      fileConfigHash: () => 'F',
      configStatus: {
        file: { path: '/cfg/config.env', found: true, error: null, warning: null },
        settings: [{ name: 'FOUNDRY_URL', value: 'http://x', source: 'file' }],
      },
    });
    await current.shared.start();

    const connection = await IpcConnection.connect(
      paths.endpoint,
      hello({
        configHash: 'ENV',
        pid: 4242,
        configSources: { FOUNDRY_URL: 'file', FOUNDRY_WRITE_ENABLED: 'env' },
        configDigests: { FOUNDRY_URL: 'u', FOUNDRY_WRITE_ENABLED: 'w-true' },
      }),
    );
    expect(connection.ignoredConfig).toEqual({
      settings: [{ name: 'FOUNDRY_WRITE_ENABLED', source: 'env' }],
      configFile: '/cfg/config.env',
    });
    expect(current.exit).not.toHaveBeenCalled();

    const control = await IpcConnection.connect(paths.endpoint, hello({ role: 'control' }));
    const status = DaemonStatusSchema.parse(await control.request('status'));
    control.close();
    connection.close();
    expect(status.config?.file.path).toBe('/cfg/config.env');
    expect(status.relayConfigs).toEqual([
      {
        pid: 4242,
        version: '1.0.0',
        sources: { FOUNDRY_URL: 'file', FOUNDRY_WRITE_ENABLED: 'env' },
        ignored: [{ name: 'FOUNDRY_WRITE_ENABLED', source: 'env' }],
      },
    ]);
    expect(JSON.stringify(status)).not.toContain('w-true');
  });

  it('serves a relay from before the configuration file without a restart loop', async () => {
    // A phase-1 relay: whole-config fingerprint, no digests nor sources.
    const paths = makePaths();
    const current = makeProcess(paths, {
      version: '1.0.0+b',
      configHash: 'F',
      configDigests: { FOUNDRY_URL: 'u' },
      fileConfigHash: () => 'F',
    });
    await current.shared.start();
    const spawn = vi.fn();
    const old = makeLink(paths, spawn, { version: '1.0.0+a', configHash: 'whole-config' });
    await expect(old.call('tool', 'get_users')).resolves.toBeDefined();
    expect(spawn).not.toHaveBeenCalled();
    expect(current.exit).not.toHaveBeenCalled();
  });

  it('a relay matching the changed file restarts the process once', async () => {
    const paths = makePaths();
    const current = makeProcess(paths, { configHash: 'OLD', fileConfigHash: () => 'NEW' });
    await current.shared.start();
    const spawn = vi.fn(() => {
      void makeProcess(paths, { configHash: 'NEW', fileConfigHash: () => 'NEW' }).shared.start();
    });
    const link = makeLink(paths, spawn, { configHash: 'NEW' });
    await expect(link.call('tool', 'get_users')).resolves.toBeDefined();
    expect(current.exit).toHaveBeenCalledWith(0);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
