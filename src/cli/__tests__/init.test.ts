/**
 * @fileoverview Tests for the `init` flow, with every external effect faked.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ResolvedSettings, SettingName, SettingSource } from '../../config/sources.js';
import { KNOWN_SETTINGS } from '../../config/sources.js';
import { packageName } from '../../shared/version.js';
import type { Verdict, WorldSnapshot } from '../checks.js';
import { type InitDeps, runInit } from '../init.js';
import { PromptCancelled, type Prompter } from '../prompt.js';

const ENTRY = 'C:\\Users\\me\\foundryvtt-mcp\\dist\\index.js';
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const GLOBAL_ENTRY =
  'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@g33ks\\foundryvtt-mcp\\dist\\index.js';
const NPX_ENTRY =
  'C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\4f3a2b1c\\node_modules\\@g33ks\\foundryvtt-mcp\\dist\\index.js';
const FILE = 'C:\\Users\\me\\AppData\\Local\\foundryvtt-mcp\\config.env';
const PASSWORD = "S3cr#t'p`w long";
const OLD_PASSWORD = 'old-secret-value';
const BRIDGE = { id: 'foundryvtt-mcp-bridge', version: '0.5.1', active: true };

/** Answers given in order, per kind of question; `undefined` = Enter alone. */
interface Script {
  asks?: Array<string | undefined>;
  secrets?: Array<string | null>;
  confirms?: Array<boolean | undefined>;
}

function scriptedPrompter(script: Script): Prompter & { pauses: string[]; questions: string[] } {
  const asks = [...(script.asks ?? [])];
  const secrets = [...(script.secrets ?? [])];
  const confirms = [...(script.confirms ?? [])];
  const pauses: string[] = [];
  const questions: string[] = [];
  const next = <T>(queue: T[], what: string): T => {
    if (queue.length === 0) {
      throw new Error(`unexpected ${what}`);
    }
    return queue.shift() as T;
  };
  return {
    pauses,
    questions,
    async ask(question, defaultValue) {
      questions.push(`${question} [${defaultValue ?? ''}]`);
      return next(asks, `question "${question}"`) ?? defaultValue ?? '';
    },
    async askSecret(question, keepable) {
      questions.push(`${question} keepable=${keepable}`);
      const answer = next(secrets, `secret "${question}"`);
      return answer === null && !keepable ? '' : answer;
    },
    async confirm(question, defaultValue) {
      questions.push(`${question} default=${defaultValue}`);
      return next(confirms, `confirm "${question}"`) ?? defaultValue;
    },
    async pause(message) {
      pauses.push(message);
    },
  };
}

function settings(
  file: Record<string, string> | null,
  env: Partial<Record<SettingName, string>> = {},
): ResolvedSettings {
  const values: Partial<Record<SettingName, string>> = { ...(file ?? {}), ...env };
  const sources = {} as Record<SettingName, SettingSource>;
  for (const name of KNOWN_SETTINGS) {
    sources[name] = name in env ? 'env' : file && name in file ? 'file' : 'default';
  }
  return {
    values,
    sources,
    file: { path: FILE, found: file !== null, error: null, warning: null },
    dotenvPath: null,
  };
}

interface Harness {
  deps: Partial<InitDeps>;
  output: string[];
  write: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  login: ReturnType<typeof vi.fn>;
  prompter: ReturnType<typeof scriptedPrompter>;
}

function harness(options: {
  file?: Record<string, string> | null;
  env?: Partial<Record<SettingName, string>>;
  script?: Script;
  probes?: Verdict[];
  logins?: Array<WorldSnapshot | Error>;
  browser?: Verdict<{ name: string; path: string; origin: 'detected' | 'configured' }>;
  running?: boolean;
  tty?: boolean;
}): Harness {
  const output: string[] = [];
  const probes = [...(options.probes ?? [])];
  const logins = [...(options.logins ?? [{ role: 3, modules: [BRIDGE] }])];
  const write = vi.fn(() => ({
    backup: options.file ? `${FILE}.bak-20261102-180000` : null,
    created: !options.file,
  }));
  const stop = vi.fn(async () => 0);
  const login = vi.fn(async () => {
    const next = logins.length > 1 ? logins.shift() : logins[0];
    if (next instanceof Error) {
      throw next;
    }
    return next as WorldSnapshot;
  });
  const prompter = scriptedPrompter(options.script ?? {});
  return {
    output,
    write,
    stop,
    login,
    prompter,
    deps: {
      prompter,
      node: NODE,
      print: (line) => output.push(line),
      resolve: () => settings(options.file ?? null, options.env),
      readFile: () => ({ ...(options.file ?? {}) }),
      probeJoin: async () =>
        probes.length > 1
          ? (probes.shift() as Verdict)
          : (probes[0] ?? { ok: true, value: undefined, message: 'FoundryVTT answers.' }),
      login,
      checkBrowser: async () =>
        options.browser ?? {
          ok: true,
          value: { name: 'Brave', path: 'C:\\b\\brave.exe', origin: 'detected' },
          message: 'Browser: Brave — started and closed.',
        },
      write,
      sharedProcessRunning: async () => options.running ?? false,
      stopSharedProcess: stop,
      terminalProblem: () => (options.tty === false ? 'needs an interactive terminal' : null),
    },
  };
}

const text = (h: Harness) => h.output.join('\n');

describe('init — new installation', () => {
  it('asks, checks, writes only what differs from the defaults, and prints the snippets', async () => {
    const h = harness({
      file: null,
      script: {
        asks: ['foundry.example.com', 'mcp-api'],
        secrets: [PASSWORD],
        confirms: [undefined],
      },
    });
    expect(await runInit([], ENTRY, h.deps)).toBe(0);

    expect(h.login).toHaveBeenCalledWith('https://foundry.example.com', 'mcp-api', PASSWORD);
    expect(h.write).toHaveBeenCalledWith(FILE, [
      ['FOUNDRY_URL', 'https://foundry.example.com'],
      ['FOUNDRY_USERNAME', 'mcp-api'],
      ['FOUNDRY_PASSWORD', PASSWORD],
      ['FOUNDRY_MODULE_BRIDGE_ENABLED', 'true'],
    ]);
    // Writes default to "no" on a new installation.
    expect(h.prompter.questions).toContain('Allow changes to the game? default=false');
    const out = text(h);
    expect(out).toContain(FILE);
    expect(out).toContain('Assistant GM');
    expect(out).toContain('"C:\\\\Users\\\\me\\\\foundryvtt-mcp\\\\dist\\\\index.js"');
    expect(out).toContain(`claude mcp add foundryvtt --scope user -- "${NODE}" "${ENTRY}"`);
    expect(out).toContain(`claude mcp add foundryvtt --scope local -- "${NODE}" "${ENTRY}"`);
    expect(out).toContain('"command": "C:\\\\Program Files\\\\nodejs\\\\node.exe"');
    expect(out).toContain(`Both name this Node.js: ${NODE}.`);
    expect(out).toContain(`run \`node "${ENTRY}" init\` again`);
    expect(out).toContain('Settings → Developer → Edit Config');
    expect(out).not.toContain(PASSWORD);
  });

  it('writes FOUNDRY_WRITE_ENABLED only when writes are allowed', async () => {
    const h = harness({
      file: null,
      script: { asks: ['https://f.example.com', 'mcp-api'], secrets: [PASSWORD], confirms: [true] },
    });
    await runInit([], ENTRY, h.deps);
    expect(h.write.mock.calls[0]?.[1]).toContainEqual(['FOUNDRY_WRITE_ENABLED', 'true']);
  });

  it('retries the address after a failed probe, Enter keeping it', async () => {
    const h = harness({
      file: null,
      probes: [
        { ok: false, message: 'No Active Game' },
        { ok: true, value: undefined, message: 'answers' },
      ],
      script: {
        asks: ['https://f.example.com', undefined, 'mcp-api'],
        secrets: [PASSWORD],
        confirms: [false],
      },
    });
    expect(await runInit([], ENTRY, h.deps)).toBe(0);
    expect(h.prompter.questions[1]).toContain('[https://f.example.com]');
    expect(text(h)).toContain('✖ No Active Game');
  });

  it('asks for the account again after a wrong password', async () => {
    const h = harness({
      file: null,
      logins: [
        new Error('FoundryVTT authentication failed (HTTP 401): JOIN.ErrorInvalidPassword'),
        { role: 3, modules: [BRIDGE] },
      ],
      script: {
        asks: ['https://f.example.com', 'mcp-api', undefined],
        secrets: ['wrong-one', PASSWORD],
        confirms: [false],
      },
    });
    expect(await runInit([], ENTRY, h.deps)).toBe(0);
    expect(text(h)).toContain('Wrong password for "mcp-api".');
    expect(h.login).toHaveBeenLastCalledWith('https://f.example.com', 'mcp-api', PASSWORD);
    expect(text(h)).not.toContain('wrong-one');
  });

  it('waits for the world, the role and the module, then checks again', async () => {
    const h = harness({
      file: null,
      logins: [
        new (await import('../../foundry/auth.js')).NoActiveWorldError(),
        { role: 1, modules: [BRIDGE] },
        { role: 3, modules: [{ ...BRIDGE, active: false }] },
        { role: 3, modules: [BRIDGE] },
      ],
      script: {
        asks: ['https://f.example.com', 'mcp-api'],
        secrets: [PASSWORD],
        confirms: [false],
      },
    });
    expect(await runInit([], ENTRY, h.deps)).toBe(0);
    expect(h.prompter.pauses).toHaveLength(3);
    const out = text(h);
    expect(out).toMatch(/no world is running/);
    expect(out).toMatch(/is a Player/);
    expect(out).toMatch(/installed but not enabled/);
  });

  it('shows the Gamemaster warning', async () => {
    const h = harness({
      file: null,
      logins: [{ role: 4, modules: [BRIDGE] }],
      script: {
        asks: ['https://f.example.com', 'mcp-api'],
        secrets: [PASSWORD],
        confirms: [false],
      },
    });
    await runInit([], ENTRY, h.deps);
    expect(text(h)).toMatch(/⚠ .*Make this account an Assistant GM/);
  });

  it('asks again for a password the file could not hold, without echoing it', async () => {
    const impossible = `a'b\`c"d`;
    const h = harness({
      file: null,
      script: {
        asks: ['https://f.example.com', 'mcp-api'],
        secrets: [impossible, PASSWORD],
        confirms: [false],
      },
    });
    expect(await runInit([], ENTRY, h.deps)).toBe(0);
    expect(text(h)).toMatch(/no quoting can carry/);
    expect(text(h)).not.toContain(impossible);
  });

  it('can go on without a browser', async () => {
    const h = harness({
      file: null,
      browser: { ok: false, message: 'No browser found for the headless GM session.' },
      script: {
        asks: ['https://f.example.com', 'mcp-api'],
        secrets: [PASSWORD],
        confirms: [false, false],
      },
    });
    expect(await runInit([], ENTRY, h.deps)).toBe(0);
    expect(text(h)).toContain('✖ No browser found');
    expect(h.write).toHaveBeenCalled();
  });

  it('stops on Ctrl+C with nothing written', async () => {
    const h = harness({ file: null, script: { asks: ['https://f.example.com'] } });
    h.prompter.ask = async () => {
      throw new PromptCancelled();
    };
    expect(await runInit([], ENTRY, h.deps)).toBe(130);
    expect(h.write).not.toHaveBeenCalled();
    expect(text(h)).toContain('nothing was written');
  });
});

describe('init — existing file', () => {
  const FILE_VALUES = {
    FOUNDRY_URL: 'https://foundry.example.com',
    FOUNDRY_USERNAME: 'mcp-api',
    FOUNDRY_PASSWORD: OLD_PASSWORD,
    FOUNDRY_WRITE_ENABLED: 'true',
    FOUNDRY_MODULE_BRIDGE_ENABLED: 'true',
    MY_OWN_KEY: 'x',
  };

  it('offers the file values as defaults, Enter keeping them, and writes nothing unchanged', async () => {
    const h = harness({
      file: FILE_VALUES,
      script: { asks: [undefined, undefined], secrets: [null], confirms: [undefined] },
    });
    expect(await runInit([], ENTRY, h.deps)).toBe(0);
    expect(h.prompter.questions).toContain(
      'FoundryVTT address (e.g. https://foundry.example.com) [https://foundry.example.com]',
    );
    expect(h.prompter.questions).toContain('Password of "mcp-api" keepable=true');
    expect(h.prompter.questions).toContain('Allow changes to the game? default=true');
    expect(h.login).toHaveBeenCalledWith('https://foundry.example.com', 'mcp-api', OLD_PASSWORD);
    expect(h.write).not.toHaveBeenCalled();
    expect(text(h)).toContain('Nothing to change');
    expect(text(h)).not.toContain(OLD_PASSWORD);
  });

  it('writes only the changed keys and reports the backup', async () => {
    const h = harness({
      file: FILE_VALUES,
      script: { asks: [undefined, undefined], secrets: [PASSWORD], confirms: [false] },
    });
    await runInit([], ENTRY, h.deps);
    expect(h.write).toHaveBeenCalledWith(FILE, [
      ['FOUNDRY_PASSWORD', PASSWORD],
      ['FOUNDRY_WRITE_ENABLED', 'false'],
    ]);
    expect(text(h)).toContain(`${FILE}.bak-20261102-180000`);
  });

  it('offers to stop a running shared process when an identity setting changed, no by default', async () => {
    const h = harness({
      file: FILE_VALUES,
      running: true,
      script: {
        asks: [undefined, undefined],
        secrets: [PASSWORD],
        confirms: [undefined, undefined],
      },
    });
    await runInit([], ENTRY, h.deps);
    expect(
      h.prompter.questions.some((q) => q.startsWith('Stop it now?') && q.endsWith('default=false')),
    ).toBe(true);
    expect(h.stop).not.toHaveBeenCalled();

    const yes = harness({
      file: FILE_VALUES,
      running: true,
      script: { asks: [undefined, undefined], secrets: [PASSWORD], confirms: [undefined, true] },
    });
    await runInit([], ENTRY, yes.deps);
    expect(yes.stop).toHaveBeenCalled();
  });

  it('does not offer to stop when nothing changed', async () => {
    const h = harness({
      file: FILE_VALUES,
      running: true,
      script: { asks: [undefined, undefined], secrets: [null], confirms: [undefined] },
    });
    await runInit([], ENTRY, h.deps);
    expect(h.prompter.questions.some((q) => q.startsWith('Stop it now?'))).toBe(false);
  });

  it('warns that the shell overrides a file value', async () => {
    const h = harness({
      file: FILE_VALUES,
      env: { FOUNDRY_URL: 'http://localhost:30000' },
      script: { asks: [undefined, undefined], secrets: [null], confirms: [undefined] },
    });
    await runInit([], ENTRY, h.deps);
    expect(text(h)).toMatch(/FOUNDRY_URL \(from the environment\)/);
  });
});

describe('init — no terminal', () => {
  it('refuses clearly and asks nothing', async () => {
    const h = harness({ tty: false });
    expect(await runInit([], ENTRY, h.deps)).toBe(2);
    expect(text(h)).toContain('needs an interactive terminal');
    expect(h.prompter.questions).toEqual([]);
    expect(h.write).not.toHaveBeenCalled();
  });

  it('rejects unknown options', async () => {
    const h = harness({});
    expect(await runInit(['--force'], ENTRY, h.deps)).toBe(2);
  });
});

describe('init --check', () => {
  const VALUES = {
    FOUNDRY_URL: 'https://foundry.example.com',
    FOUNDRY_USERNAME: 'mcp-api',
    FOUNDRY_PASSWORD: OLD_PASSWORD,
    FOUNDRY_MODULE_BRIDGE_ENABLED: 'true',
  };

  it('runs every check without asking or writing, even without a terminal', async () => {
    const h = harness({ file: VALUES, tty: false });
    expect(await runInit(['--check'], ENTRY, h.deps)).toBe(0);
    expect(h.prompter.questions).toEqual([]);
    expect(h.write).not.toHaveBeenCalled();
    const out = text(h);
    expect(out).toContain('✔ FoundryVTT answers.');
    expect(out).toContain('✔ Logged in as "mcp-api" (Assistant GM).');
    expect(out).toContain('✔ Companion module foundryvtt-mcp-bridge v0.5.1 installed and enabled.');
    expect(out).toContain('✔ Browser: Brave');
    expect(out).toContain('All checks passed.');
    expect(out).not.toContain(OLD_PASSWORD);
  });

  it("checks normally from npx's cache", async () => {
    const h = harness({ file: VALUES, tty: false });
    expect(await runInit(['--check'], NPX_ENTRY, h.deps)).toBe(0);
    expect(h.write).not.toHaveBeenCalled();
    expect(text(h)).toContain('All checks passed.');
    expect(text(h)).not.toContain("npx's cache");
  });

  it('fails on a missing module, with the install steps but no Enter prompt', async () => {
    const h = harness({ file: VALUES, logins: [{ role: 3, modules: [] }] });
    expect(await runInit(['--check'], ENTRY, h.deps)).toBe(1);
    expect(text(h)).toContain('Install Module');
    expect(text(h)).not.toContain('press Enter');
  });

  it('skips the login when the server is unreachable, still checking the browser', async () => {
    const h = harness({ file: VALUES, probes: [{ ok: false, message: 'refused the connection' }] });
    expect(await runInit(['--check'], ENTRY, h.deps)).toBe(1);
    expect(h.login).not.toHaveBeenCalled();
    expect(text(h)).toContain('✔ Browser: Brave');
  });

  it('says what to run when nothing is configured', async () => {
    const h = harness({ file: null });
    expect(await runInit(['--check'], ENTRY, h.deps)).toBe(1);
    expect(text(h)).toContain(`FOUNDRY_URL is not set: run \`node "${ENTRY}" init\``);
  });
});

describe('init — the commands it prints', () => {
  const RUN = `node "${ENTRY}"`;

  it('prints commands that work after a plain clone', async () => {
    const h = harness({
      file: null,
      script: { asks: ['foundry.example.com', 'mcp-api'], secrets: [PASSWORD], confirms: [true] },
    });
    expect(await runInit([], ENTRY, h.deps)).toBe(0);
    const out = text(h);
    expect(out).toContain(`\`${RUN} stop\` so the shared process restarts with it.`);
    expect(out).toContain(`To check it again later: ${RUN} init --check`);
    expect(out).not.toMatch(/foundryvtt-mcp (init|stop|status)/);
  });

  it('names the stop command when the shared process keeps the old settings', async () => {
    const h = harness({
      file: { FOUNDRY_URL: 'https://foundry.example.com', FOUNDRY_USERNAME: 'old' },
      running: true,
      script: { asks: [undefined, 'mcp-api'], secrets: [PASSWORD], confirms: [undefined, false] },
    });
    await runInit([], ENTRY, h.deps);
    expect(text(h)).toContain(`It keeps the previous settings until \`${RUN} stop\`.`);
  });

  it('shows the usage with the same command', async () => {
    const h = harness({});
    await runInit(['--force'], ENTRY, h.deps);
    expect(text(h)).toContain(`Usage: ${RUN} init [--check]`);
  });

  it('uses the package command when init was started by that name', async () => {
    const h = harness({
      file: null,
      script: {
        asks: ['foundry.example.com', 'mcp-api'],
        secrets: [PASSWORD],
        confirms: [undefined],
      },
    });
    await runInit([], ENTRY, { ...h.deps, command: 'foundryvtt-mcp' });
    expect(text(h)).toContain('To check it again later: foundryvtt-mcp init --check');
  });

  it('uses the package command and the installed paths for a global install', async () => {
    const h = harness({
      file: null,
      script: {
        asks: ['foundry.example.com', 'mcp-api'],
        secrets: [PASSWORD],
        confirms: [undefined],
      },
    });
    expect(await runInit([], GLOBAL_ENTRY, h.deps)).toBe(0);
    const out = text(h);
    expect(out).toContain(`claude mcp add foundryvtt --scope user -- "${NODE}" "${GLOBAL_ENTRY}"`);
    expect(out).toContain('run `foundryvtt-mcp init` again');
    expect(out).toContain('To check it again later: foundryvtt-mcp init --check');
  });

  it("prints no client entry from npx's cache, and says how to install instead", async () => {
    const h = harness({
      file: null,
      script: {
        asks: ['foundry.example.com', 'mcp-api'],
        secrets: [PASSWORD],
        confirms: [undefined],
      },
    });
    expect(await runInit([], NPX_ENTRY, h.deps)).toBe(0);
    const out = text(h);
    // The configuration is still written.
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(out).not.toContain('mcpServers');
    expect(out).not.toContain('claude mcp add');
    expect(out).toContain("No client entry printed: this connector runs from npx's cache,");
    expect(out).toContain(NPX_ENTRY);
    expect(out).toContain(`  npm install -g ${packageName()}`);
    expect(out).toContain('  foundryvtt-mcp init');
    expect(out).toContain(`To check it again later: npx ${packageName()} init --check`);
  });
});
