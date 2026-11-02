/**
 * @fileoverview Finds a Chromium-based browser for the headless GM session.
 *
 * Known install locations per system, checked on disk, in this order:
 * Chrome, Edge, Brave, Vivaldi, a system Chromium, then Playwright's own
 * Chromium. The browser is then launched by its executable path, never by a
 * Playwright channel: channels build their Windows paths from environment
 * variables that an MCP client may not pass on (Claude desktop forwards an
 * allowlist without `ProgramFiles(x86)`), so the Windows prefixes here also
 * fall back on `SYSTEMDRIVE` and on hard-coded `C:\` paths.
 *
 * Pure apart from the default `exists`: tests pass a simulated file system.
 */

import { statSync } from 'node:fs';
import path from 'node:path';

export interface FoundBrowser {
  /** e.g. `Brave`. */
  name: string;
  path: string;
}

/** The browser the session runs, and whether the user chose it. */
export interface BrowserChoice extends FoundBrowser {
  origin: 'configured' | 'detected';
}

export interface BrowserSearch {
  /** Every browser present, in preference order. */
  found: FoundBrowser[];
  /** Every location checked, found or not. */
  tried: string[];
}

export interface FindBrowsersOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** True when `file` is an existing file. */
  exists?: (file: string) => boolean;
  homedir?: string;
  /** Where Playwright's own Chromium would be (`chromium.executablePath()`). */
  playwrightPath?: string | null;
}

/** Install advice when nothing was found. */
export const NO_BROWSER_ADVICE =
  'Install Google Chrome, Microsoft Edge or Brave, or set FOUNDRY_HEADLESS_GM_EXECUTABLE_PATH ' +
  'to the executable of a Chromium-based browser.';

const PLAYWRIGHT_CHROMIUM = "Playwright's Chromium";

function fileExists(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** `env[name]` ignoring case, as Windows does (a plain object does not). */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  const value = key !== undefined ? env[key] : undefined;
  return value ? value : undefined;
}

function unique(paths: string[], caseInsensitive: boolean): string[] {
  const seen = new Set<string>();
  return paths.filter((p) => {
    const key = caseInsensitive ? p.toLowerCase() : p;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** Directories that may hold `Vendor\Product\Application\x.exe`, machine-wide first. */
function windowsPrefixes(env: NodeJS.ProcessEnv): string[] {
  const join = path.win32.join;
  const drive = envValue(env, 'SYSTEMDRIVE') ?? envValue(env, 'HOMEDRIVE');
  const profile = envValue(env, 'USERPROFILE');
  const candidates = [
    envValue(env, 'PROGRAMFILES'),
    envValue(env, 'PROGRAMFILES(X86)'),
    envValue(env, 'LOCALAPPDATA'),
    drive ? join(`${drive}\\`, 'Program Files') : undefined,
    drive ? join(`${drive}\\`, 'Program Files (x86)') : undefined,
    profile ? join(profile, 'AppData', 'Local') : undefined,
    'C:\\Program Files',
    'C:\\Program Files (x86)',
  ];
  return unique(
    candidates.filter((p): p is string => p !== undefined),
    true,
  );
}

const WINDOWS_SUFFIXES: Array<[string, string]> = [
  ['Chrome', 'Google\\Chrome\\Application\\chrome.exe'],
  ['Edge', 'Microsoft\\Edge\\Application\\msedge.exe'],
  ['Brave', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
  ['Vivaldi', 'Vivaldi\\Application\\vivaldi.exe'],
  ['Chromium', 'Chromium\\Application\\chrome.exe'],
];

const MAC_APPS: Array<[string, string]> = [
  ['Chrome', 'Google Chrome.app/Contents/MacOS/Google Chrome'],
  ['Edge', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  ['Brave', 'Brave Browser.app/Contents/MacOS/Brave Browser'],
  ['Vivaldi', 'Vivaldi.app/Contents/MacOS/Vivaldi'],
  ['Chromium', 'Chromium.app/Contents/MacOS/Chromium'],
];

/** Fixed paths first, then commands looked up on PATH (and the usual bin dirs). */
const LINUX_LOCATIONS: Array<[string, string[], string[]]> = [
  ['Chrome', ['/opt/google/chrome/chrome'], ['google-chrome-stable', 'google-chrome']],
  ['Edge', ['/opt/microsoft/msedge/msedge'], ['microsoft-edge-stable', 'microsoft-edge']],
  ['Brave', ['/opt/brave.com/brave/brave'], ['brave-browser', 'brave']],
  ['Vivaldi', ['/opt/vivaldi/vivaldi'], ['vivaldi-stable', 'vivaldi']],
  [
    'Chromium',
    ['/usr/lib/chromium/chromium', '/usr/lib/chromium-browser/chromium-browser'],
    ['chromium', 'chromium-browser'],
  ],
];

function candidatesFor(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homedir: string | undefined,
): Array<[string, string]> {
  if (platform === 'win32') {
    const prefixes = windowsPrefixes(env);
    return WINDOWS_SUFFIXES.flatMap(([name, suffix]) =>
      prefixes.map((prefix): [string, string] => [name, path.win32.join(prefix, suffix)]),
    );
  }
  if (platform === 'darwin') {
    const roots = ['/Applications', ...(homedir ? [path.posix.join(homedir, 'Applications')] : [])];
    return MAC_APPS.flatMap(([name, app]) =>
      roots.map((root): [string, string] => [name, path.posix.join(root, app)]),
    );
  }
  const pathDirs = unique(
    [
      ...(envValue(env, 'PATH') ?? '').split(':').filter(Boolean),
      '/usr/bin',
      '/usr/local/bin',
      '/snap/bin',
    ],
    false,
  );
  return LINUX_LOCATIONS.flatMap(([name, fixed, commands]) => [
    ...fixed.map((p): [string, string] => [name, p]),
    ...commands.flatMap((command) =>
      pathDirs.map((dir): [string, string] => [name, path.posix.join(dir, command)]),
    ),
  ]);
}

/** Every Chromium-based browser present, in preference order, and every path checked. */
export function findBrowsers(options: FindBrowsersOptions = {}): BrowserSearch {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? fileExists;
  const candidates = candidatesFor(platform, env, options.homedir);
  if (options.playwrightPath) {
    candidates.push([PLAYWRIGHT_CHROMIUM, options.playwrightPath]);
  }

  const found: FoundBrowser[] = [];
  const tried: string[] = [];
  const seenNames = new Set<string>();
  const seenPaths = new Set<string>();
  for (const [name, file] of candidates) {
    const key = platform === 'win32' ? file.toLowerCase() : file;
    if (seenPaths.has(key)) {
      continue;
    }
    seenPaths.add(key);
    tried.push(file);
    // One location per browser: the first is the one that would run.
    if (!seenNames.has(name) && exists(file)) {
      found.push({ name, path: file });
      seenNames.add(name);
    }
  }
  return { found, tried };
}

/** Error text when no browser is installed at any known location. */
export function noBrowserMessage(tried: string[]): string {
  return [
    `No browser found for the headless GM session. ${NO_BROWSER_ADVICE}`,
    'Without this session the companion module cannot connect to the bridge.',
    `Locations tried: ${tried.join('; ')}`,
  ].join(' ');
}

/** Name of the browser an explicit path points to, from its file name. */
export function browserNameFromPath(file: string): string {
  const base = (file.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '');
  if (base.startsWith('brave')) {
    return 'Brave';
  }
  if (
    base.startsWith('msedge') ||
    base.startsWith('microsoft edge') ||
    base.startsWith('microsoft-edge')
  ) {
    return 'Edge';
  }
  if (base.startsWith('vivaldi')) {
    return 'Vivaldi';
  }
  if (base.startsWith('chromium') || (base === 'chrome' && /chromium|ms-playwright/i.test(file))) {
    return 'Chromium';
  }
  if (base === 'chrome' || base.startsWith('google chrome') || base.startsWith('google-chrome')) {
    return 'Chrome';
  }
  return 'Browser';
}

/** e.g. `Brave — C:\…\brave.exe (detected)`. */
export function describeBrowser(choice: BrowserChoice): string {
  return `${choice.name} — ${choice.path} (${choice.origin})`;
}
