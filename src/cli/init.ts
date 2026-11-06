/**
 * @fileoverview `foundryvtt-mcp init`: writes a working configuration file,
 * checking each answer against the live FoundryVTT, then prints what to
 * paste into Claude desktop and Claude Code. `init --check` runs the same
 * checks on the existing configuration, asking and writing nothing.
 *
 * The two-account mode (`FOUNDRY_HEADLESS_GM_USERNAME`) stays out of it: an
 * advanced option, set by hand in the file.
 *
 * Nothing printed here carries a password: secrets show as `<set>`.
 */

import { type ResolvedSettings, readConfigFile, resolveSettings } from '../config/sources.js';
import type { BrowserChoice } from '../foundry/browser-detect.js';
import { IDENTITY_SETTINGS } from '../shared/config-hash.js';
import { packageName } from '../shared/version.js';
import {
  checkBrowser,
  describeLoginError,
  evaluateModule,
  evaluateRole,
  loginAndReadWorld,
  normalizeUrl,
  probeJoin,
  type Verdict,
  type WorldSnapshot,
} from './checks.js';
import { quoteValue, UnwritableValueError, type WriteResult, writeConfig } from './config-file.js';
import { PromptCancelled, type Prompter, terminalProblem, terminalPrompter } from './prompt.js';
import {
  claudeCodeCommand,
  claudeCodePowerShellNote,
  claudeDesktopSnippet,
  connectorCommand,
  installKind,
} from './snippets.js';

export interface InitDeps {
  prompter: Prompter;
  print: (line: string) => void;
  /** Absolute path of `dist/index.js`, for the client snippets. */
  entry: string;
  /** Absolute path of the Node.js running `init` (`process.execPath`), for the client snippets. */
  node: string;
  /** How to run the connector from a terminal, in the commands `init` prints. */
  command: string;
  resolve: () => ResolvedSettings;
  readFile: (file: string) => Record<string, string>;
  probeJoin: (url: string) => Promise<Verdict>;
  login: (url: string, username: string, password: string) => Promise<WorldSnapshot>;
  checkBrowser: (executablePath: string | undefined) => Promise<Verdict<BrowserChoice>>;
  write: (file: string, updates: Array<[string, string]>) => WriteResult;
  sharedProcessRunning: () => Promise<boolean>;
  stopSharedProcess: () => Promise<number>;
  terminalProblem: () => string | null;
}

/** Keys `init` writes; everything else in the file is left alone. */
type ManagedKey =
  | 'FOUNDRY_URL'
  | 'FOUNDRY_USERNAME'
  | 'FOUNDRY_PASSWORD'
  | 'FOUNDRY_MODULE_BRIDGE_ENABLED'
  | 'FOUNDRY_WRITE_ENABLED';

const MANAGED_KEYS: ManagedKey[] = [
  'FOUNDRY_URL',
  'FOUNDRY_USERNAME',
  'FOUNDRY_PASSWORD',
  'FOUNDRY_MODULE_BRIDGE_ENABLED',
  'FOUNDRY_WRITE_ENABLED',
];

const ACCOUNT_ADVICE = [
  'The connector logs in to FoundryVTT as a user of its own. Create one for it (Game Settings →',
  'User Management): an Assistant GM — the companion module and the invisible GM browser session',
  'need a GM role, and an Assistant GM never takes over from your own Gamemaster — with a long,',
  'unique password used nowhere else.',
];

function writeAdvice(command: string): string[] {
  return [
    'Allow changes to the game? With "yes", the assistant can create, edit and delete documents',
    '(actors, journals, scenes, tokens, combat…) in the world. With "no", it can only read.',
    'To change your mind later: edit FOUNDRY_WRITE_ENABLED in the configuration file, then run',
    `\`${command} stop\` so the shared process restarts with it.`,
  ];
}

/** Why `init` prints no client entry when it runs from npx's cache, and what to do. */
function npxAdvice(entry: string): string[] {
  return [
    "No client entry printed: this connector runs from npx's cache,",
    `  ${entry}`,
    'which npm replaces or deletes when it updates or cleans that cache. Install it once instead:',
    `  npm install -g ${packageName()}`,
    'then run:',
    '  foundryvtt-mcp init',
    'to get the Claude desktop and Claude Code entries. The configuration written above is kept.',
  ];
}

function ok(print: InitDeps['print'], message: string): void {
  print(`✔ ${message}`);
}

function fail(print: InitDeps['print'], message: string): void {
  print(`✖ ${message}`);
}

function warn(print: InitDeps['print'], message: string | undefined): void {
  if (message) {
    print(`⚠ ${message}`);
  }
}

/** Settings this shell would take from somewhere else than the file. */
function overriddenInShell(settings: ResolvedSettings): string[] {
  return MANAGED_KEYS.filter((key) => {
    const source = settings.sources[key];
    return source === 'env' || source === '.env';
  }).map(
    (key) =>
      `${key} (from ${settings.sources[key] === 'env' ? 'the environment' : settings.dotenvPath})`,
  );
}

// ---------------------------------------------------------------------------
// init --check
// ---------------------------------------------------------------------------

async function runCheck(deps: InitDeps): Promise<number> {
  const { print } = deps;
  const settings = deps.resolve();
  const v = settings.values;
  print(`Configuration file: ${settings.file.path}${settings.file.found ? '' : ' (not found)'}`);
  if (settings.file.error) {
    warn(print, settings.file.error);
  }
  warn(print, settings.file.warning ?? undefined);
  let healthy = true;

  const url = normalizeUrl(v.FOUNDRY_URL ?? '');
  if (!v.FOUNDRY_URL || !url.ok) {
    fail(
      print,
      v.FOUNDRY_URL
        ? url.message
        : `FOUNDRY_URL is not set: run \`${deps.command} init\` to write it.`,
    );
    healthy = false;
  } else {
    warn(print, url.warning);
    const join = await deps.probeJoin(url.value);
    (join.ok ? ok : fail)(print, join.message);
    healthy &&= join.ok;

    const username = v.FOUNDRY_USERNAME ?? v.FOUNDRY_USER_ID;
    if (!join.ok) {
      print('  (login, role and module not checked)');
    } else if (!username || !v.FOUNDRY_PASSWORD) {
      fail(
        print,
        `FOUNDRY_USERNAME or FOUNDRY_PASSWORD is not set: run \`${deps.command} init\` to write them.`,
      );
      healthy = false;
    } else {
      try {
        const world = await deps.login(url.value, username, v.FOUNDRY_PASSWORD);
        const role = evaluateRole(username, world.role);
        (role.ok ? ok : fail)(print, role.message);
        if (role.ok) {
          warn(print, role.warning);
        }
        const module = evaluateModule(world.modules);
        (module.ok ? ok : fail)(
          print,
          module.message.replace(/\nThen press Enter here to check again\.$/, ''),
        );
        healthy &&= role.ok && module.ok;
      } catch (error) {
        fail(print, describeLoginError(url.value, username, error).message);
        healthy = false;
      }
    }
  }

  if (v.FOUNDRY_MODULE_BRIDGE_ENABLED !== 'true') {
    warn(
      print,
      'FOUNDRY_MODULE_BRIDGE_ENABLED is not true: the companion module, and the tools that need it ' +
        '(capture_scene…), stay off.',
    );
  }
  if (v.FOUNDRY_HEADLESS_GM_ENABLED === 'false') {
    print(
      '  Headless GM session disabled (FOUNDRY_HEADLESS_GM_ENABLED=false): browser not checked.',
    );
  } else {
    const browser = await deps.checkBrowser(v.FOUNDRY_HEADLESS_GM_EXECUTABLE_PATH);
    (browser.ok ? ok : fail)(print, browser.message);
    healthy &&= browser.ok;
  }

  print(healthy ? 'All checks passed.' : 'Some checks failed: see above.');
  return healthy ? 0 : 1;
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

interface Answers {
  url: string;
  username: string;
  /** `null`: keep the file's password. */
  password: string | null;
}

async function askUrl(deps: InitDeps, current: string | undefined): Promise<string> {
  const { print, prompter } = deps;
  let typed = current;
  for (;;) {
    const answer = await prompter.ask(
      'FoundryVTT address (e.g. https://foundry.example.com)',
      typed,
    );
    typed = answer || typed;
    const url = normalizeUrl(answer);
    if (!url.ok) {
      fail(print, url.message);
      continue;
    }
    warn(print, url.warning);
    const join = await deps.probeJoin(url.value);
    if (join.ok) {
      ok(print, join.message);
      return url.value;
    }
    fail(print, join.message);
    print('Press Enter to try again with the same address, or type another one.');
    typed = url.value;
  }
}

async function askAccount(
  deps: InitDeps,
  username: string | undefined,
  hasPassword: boolean,
): Promise<{ username: string; password: string | null }> {
  const { prompter, print } = deps;
  let name = '';
  while (name === '') {
    name = (await prompter.ask('FoundryVTT user for the connector', username)).trim();
    if (name === '') {
      fail(print, 'Type the name of the FoundryVTT user.');
    }
  }
  for (;;) {
    const password = await prompter.askSecret(`Password of "${name}"`, hasPassword);
    if (password === '') {
      fail(print, 'The password cannot be empty.');
      continue;
    }
    try {
      // Refused now rather than after every check: the file could not hold it.
      if (password !== null) {
        quoteValue('FOUNDRY_PASSWORD', password);
      }
      quoteValue('FOUNDRY_USERNAME', name);
    } catch (error) {
      fail(print, error instanceof Error ? error.message : String(error));
      continue;
    }
    return { username: name, password };
  }
}

/** Login, role and module, until they all pass; may send the user back to the URL. */
async function checkAccount(
  deps: InitDeps,
  fileValues: Record<string, string>,
  first: Answers,
): Promise<Answers> {
  const { print, prompter } = deps;
  const answers = { ...first };
  for (;;) {
    const password = answers.password ?? fileValues.FOUNDRY_PASSWORD ?? '';
    let world: WorldSnapshot;
    try {
      world = await deps.login(answers.url, answers.username, password);
    } catch (error) {
      const { message, retry } = describeLoginError(answers.url, answers.username, error);
      fail(print, message);
      if (retry === 'world') {
        await prompter.pause('Press Enter once the world is running.');
      } else if (retry === 'url') {
        answers.url = await askUrl(deps, answers.url);
      } else {
        const account = await askAccount(
          deps,
          answers.username,
          answers.password !== null || !!fileValues.FOUNDRY_PASSWORD,
        );
        answers.username = account.username;
        answers.password = account.password ?? answers.password;
      }
      continue;
    }

    const role = evaluateRole(answers.username, world.role);
    if (!role.ok) {
      fail(print, role.message);
      await prompter.pause('Press Enter to log in again.');
      continue;
    }
    ok(print, role.message);
    warn(print, role.warning);

    const module = evaluateModule(world.modules);
    if (!module.ok) {
      fail(print, module.message);
      await prompter.pause('Press Enter to check again.');
      continue;
    }
    ok(print, module.message);
    return answers;
  }
}

async function checkBrowserStep(deps: InitDeps, executablePath: string | undefined): Promise<void> {
  const { print, prompter } = deps;
  for (;;) {
    print(
      executablePath
        ? `Browser configured: ${executablePath}`
        : 'Looking for a Chromium-based browser…',
    );
    const browser = await deps.checkBrowser(executablePath);
    if (browser.ok) {
      ok(print, browser.message);
      return;
    }
    fail(print, browser.message);
    const retry = await prompter.confirm(
      'Try again? ("no" goes on without it: the tools that need the companion module stay unavailable)',
      true,
    );
    if (!retry) {
      return;
    }
  }
}

async function runInteractive(deps: InitDeps): Promise<number> {
  const { print, prompter } = deps;
  const settings = deps.resolve();
  const file = settings.file.path;
  const fileValues = settings.file.found ? deps.readFile(file) : {};
  print('FoundryVTT MCP — setup');
  print(
    `Configuration file: ${file}${settings.file.found ? ' (exists: its values are the defaults)' : ' (will be created)'}`,
  );
  if (settings.file.error) {
    fail(print, `${settings.file.error}. Fix or move the file, then run init again.`);
    return 1;
  }
  const overridden = overriddenInShell(settings);
  if (overridden.length > 0) {
    warn(
      print,
      `Set outside the file in this shell, and winning over it here: ${overridden.join(', ')}. ` +
        'The values below go to the file only.',
    );
  }
  print('');

  // 2. URL
  const url = await askUrl(deps, fileValues.FOUNDRY_URL);
  print('');

  // 3–5. Account, role, module
  for (const line of ACCOUNT_ADVICE) {
    print(line);
  }
  const account = await askAccount(
    deps,
    fileValues.FOUNDRY_USERNAME,
    !!fileValues.FOUNDRY_PASSWORD,
  );
  const answers = await checkAccount(deps, fileValues, { url, ...account });
  print('');

  // 6. Browser
  await checkBrowserStep(deps, fileValues.FOUNDRY_HEADLESS_GM_EXECUTABLE_PATH);
  print('');

  // Writes
  for (const line of writeAdvice(deps.command)) {
    print(line);
  }
  const allowWrites = await prompter.confirm(
    'Allow changes to the game?',
    settings.file.found ? fileValues.FOUNDRY_WRITE_ENABLED === 'true' : false,
  );
  print('');

  // 7. File
  const wanted: Partial<Record<ManagedKey, string>> = {
    FOUNDRY_URL: answers.url,
    FOUNDRY_USERNAME: answers.username,
    ...(answers.password !== null ? { FOUNDRY_PASSWORD: answers.password } : {}),
    FOUNDRY_MODULE_BRIDGE_ENABLED: 'true',
    // false is the default: written only to change a value already in the file.
    ...(allowWrites || fileValues.FOUNDRY_WRITE_ENABLED !== undefined
      ? { FOUNDRY_WRITE_ENABLED: allowWrites ? 'true' : 'false' }
      : {}),
  };
  const updates = MANAGED_KEYS.flatMap((key): Array<[string, string]> => {
    const value = wanted[key];
    return value !== undefined && value !== fileValues[key] ? [[key, value]] : [];
  });
  if (updates.length === 0) {
    ok(print, `Nothing to change in ${file}.`);
  } else {
    try {
      const result = deps.write(file, updates);
      if (result.backup) {
        print(`Previous file copied to ${result.backup}`);
      }
      ok(
        print,
        `${result.created ? 'Created' : 'Updated'} ${file} (${updates.map(([key]) => key).join(', ')}), read back and checked.`,
      );
    } catch (error) {
      fail(print, error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
  print('');

  // 8. Snippets
  if (installKind(deps.entry) === 'npx') {
    for (const line of npxAdvice(deps.entry)) {
      print(line);
    }
  } else {
    print('Claude desktop — Settings → Developer → Edit Config opens claude_desktop_config.json.');
    print('Add this entry (merge it into "mcpServers" if the file already has one):');
    print(claudeDesktopSnippet(deps.node, deps.entry));
    print('Then quit Claude desktop completely and start it again.');
    print('');
    print('Claude Code — register the connector for all your projects:');
    print(`  ${claudeCodeCommand(deps.node, deps.entry)}`);
    print('or for the current project only, on this machine:');
    print(`  ${claudeCodeCommand(deps.node, deps.entry, 'local')}`);
    const powerShellNote = claudeCodePowerShellNote(deps.node);
    if (powerShellNote) {
      print(powerShellNote);
    }
    print('');
    print(
      `Both name this Node.js: ${deps.node}. After changing or updating Node.js (nvm, installer), run \`${deps.command} init\` again for new ones.`,
    );
  }
  print('');

  // 9. Shared process
  const identityChanged = updates.some(([key]) => key in IDENTITY_SETTINGS);
  if (identityChanged && (await deps.sharedProcessRunning())) {
    print('The shared process is running with the previous connection settings.');
    if (
      await prompter.confirm(
        'Stop it now? It restarts with the new settings on the next tool call.',
        false,
      )
    ) {
      await deps.stopSharedProcess();
    } else {
      print(`It keeps the previous settings until \`${deps.command} stop\`.`);
    }
  }
  ok(print, `Setup complete. To check it again later: ${deps.command} init --check`);
  return 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function defaultDeps(entry: string): Promise<InitDeps> {
  const { isEndpointAlive } = await import('../shared/ipc-server.js');
  const { resolveSharedPaths } = await import('../shared/paths.js');
  const { runStop } = await import('../shared/control.js');
  const command = connectorCommand(entry);
  return {
    prompter: terminalPrompter(),
    print: (line) => process.stdout.write(`${line}\n`),
    entry,
    node: process.execPath,
    command,
    resolve: () => resolveSettings(),
    readFile: (file) => readConfigFile(file).values,
    probeJoin: (url) => probeJoin(url),
    login: loginAndReadWorld,
    checkBrowser,
    write: (file, updates) => writeConfig(file, updates),
    sharedProcessRunning: () => isEndpointAlive(resolveSharedPaths().endpoint),
    stopSharedProcess: () => runStop(),
    terminalProblem: () => terminalProblem(process.stdin, process.stdout, command),
  };
}

/** `init [--check]`; returns the exit code. */
export async function runInit(
  args: string[],
  entry: string,
  injected?: Partial<InitDeps>,
): Promise<number> {
  const deps = { ...(await defaultDeps(entry)), ...injected };
  // The connector's own log lines (authentication…) would interleave with the questions.
  const { logger } = await import('../utils/logger.js');
  logger.setLevel('error');

  const unknown = args.filter((arg) => arg !== '--check');
  if (unknown.length > 0) {
    deps.print(`Unknown option: ${unknown.join(' ')}\nUsage: ${deps.command} init [--check]`);
    return 2;
  }
  if (args.includes('--check')) {
    return await runCheck(deps);
  }
  const problem = deps.terminalProblem();
  if (problem) {
    deps.print(problem);
    return 2;
  }
  try {
    return await runInteractive(deps);
  } catch (error) {
    if (error instanceof PromptCancelled) {
      deps.print('Cancelled: nothing was written.');
      return 130;
    }
    if (error instanceof UnwritableValueError) {
      deps.print(`✖ ${error.message}`);
      return 1;
    }
    throw error;
  }
}
