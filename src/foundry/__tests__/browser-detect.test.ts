/**
 * @fileoverview Tests for the browser detection of the headless GM session.
 */

import { describe, expect, it } from 'vitest';
import { describeBrowser, findBrowsers, noBrowserMessage } from '../browser-detect.js';

/** A simulated file system holding exactly `files`. */
function disk(...files: string[]): (file: string) => boolean {
  const set = new Set(files.map((f) => f.toLowerCase()));
  return (file) => set.has(file.toLowerCase());
}

/** Claude desktop's allowlist on Windows: no ProgramFiles(x86). */
const CLAUDE_DESKTOP_ENV = {
  LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
  PROGRAMFILES: 'C:\\Program Files',
  SYSTEMDRIVE: 'C:',
  USERPROFILE: 'C:\\Users\\me',
};

describe('findBrowsers — Windows', () => {
  const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const EDGE_X86 = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const BRAVE = 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
  const VIVALDI_USER = 'C:\\Users\\me\\AppData\\Local\\Vivaldi\\Application\\vivaldi.exe';
  const CHROMIUM_USER = 'C:\\Users\\me\\AppData\\Local\\Chromium\\Application\\chrome.exe';
  const PLAYWRIGHT =
    'C:\\Users\\me\\AppData\\Local\\ms-playwright\\chromium-1\\chrome-win\\chrome.exe';

  it('orders Chrome, Edge, Brave, Vivaldi, Chromium, then Playwright', () => {
    const { found } = findBrowsers({
      platform: 'win32',
      env: CLAUDE_DESKTOP_ENV,
      exists: disk(PLAYWRIGHT, CHROMIUM_USER, VIVALDI_USER, BRAVE, EDGE_X86, CHROME),
      playwrightPath: PLAYWRIGHT,
    });
    expect(found.map((b) => b.name)).toEqual([
      'Chrome',
      'Edge',
      'Brave',
      'Vivaldi',
      'Chromium',
      "Playwright's Chromium",
    ]);
  });

  it('finds Edge in Program Files (x86) without the ProgramFiles(x86) variable', () => {
    const { found } = findBrowsers({
      platform: 'win32',
      env: CLAUDE_DESKTOP_ENV,
      exists: disk(EDGE_X86),
    });
    expect(found).toEqual([{ name: 'Edge', path: EDGE_X86 }]);
  });

  it('falls back on hard-coded C:\\ paths with an empty environment', () => {
    const { found } = findBrowsers({ platform: 'win32', env: {}, exists: disk(BRAVE, EDGE_X86) });
    expect(found.map((b) => b.name)).toEqual(['Edge', 'Brave']);
  });

  it('uses SYSTEMDRIVE when the system lives on another drive', () => {
    const brave = 'D:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
    const { found } = findBrowsers({
      platform: 'win32',
      env: { SYSTEMDRIVE: 'D:' },
      exists: disk(brave),
    });
    expect(found).toEqual([{ name: 'Brave', path: brave }]);
  });

  it('reads environment variables regardless of case', () => {
    const chrome = 'E:\\Apps\\Google\\Chrome\\Application\\chrome.exe';
    const { found } = findBrowsers({
      platform: 'win32',
      env: { ProgramFiles: 'E:\\Apps' },
      exists: disk(chrome),
    });
    expect(found).toEqual([{ name: 'Chrome', path: chrome }]);
  });

  it('keeps one location per browser and lists each path tried once', () => {
    const { found, tried } = findBrowsers({
      platform: 'win32',
      env: { ...CLAUDE_DESKTOP_ENV, 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)' },
      exists: disk(
        BRAVE,
        'C:\\Users\\me\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      ),
    });
    expect(found).toEqual([{ name: 'Brave', path: BRAVE }]);
    expect(new Set(tried.map((t) => t.toLowerCase())).size).toBe(tried.length);
    expect(tried).toContain(EDGE_X86);
  });

  it('finds nothing on a machine without any browser, listing what it tried', () => {
    const { found, tried } = findBrowsers({
      platform: 'win32',
      env: CLAUDE_DESKTOP_ENV,
      exists: disk(),
    });
    expect(found).toEqual([]);
    expect(tried).toContain(CHROME);
    const message = noBrowserMessage(tried);
    expect(message).toMatch(/No browser found/);
    expect(message).toMatch(/Install Google Chrome, Microsoft Edge or Brave/);
    expect(message).toContain('FOUNDRY_HEADLESS_GM_EXECUTABLE_PATH');
    expect(message).toContain(CHROME);
  });
});

describe('findBrowsers — macOS', () => {
  it('checks /Applications, then ~/Applications', () => {
    const vivaldi = '/Users/me/Applications/Vivaldi.app/Contents/MacOS/Vivaldi';
    const brave = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
    const { found, tried } = findBrowsers({
      platform: 'darwin',
      env: {},
      homedir: '/Users/me',
      exists: disk(vivaldi, brave),
    });
    expect(found).toEqual([
      { name: 'Brave', path: brave },
      { name: 'Vivaldi', path: vivaldi },
    ]);
    expect(tried[0]).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  });
});

describe('findBrowsers — Linux', () => {
  it('finds commands on PATH and in /snap/bin', () => {
    const { found } = findBrowsers({
      platform: 'linux',
      env: { PATH: '/home/me/bin:/usr/bin' },
      exists: (file) => file === '/usr/bin/brave-browser' || file === '/snap/bin/chromium',
    });
    expect(found).toEqual([
      { name: 'Brave', path: '/usr/bin/brave-browser' },
      { name: 'Chromium', path: '/snap/bin/chromium' },
    ]);
  });

  it('prefers the fixed /opt location over PATH', () => {
    const { found } = findBrowsers({
      platform: 'linux',
      env: { PATH: '/usr/bin' },
      exists: (file) => file === '/opt/google/chrome/chrome' || file === '/usr/bin/google-chrome',
    });
    expect(found).toEqual([{ name: 'Chrome', path: '/opt/google/chrome/chrome' }]);
  });

  it('checks the usual bin directories even with an empty PATH', () => {
    const { found } = findBrowsers({
      platform: 'linux',
      env: {},
      exists: (file) => file === '/usr/bin/chromium',
    });
    expect(found).toEqual([{ name: 'Chromium', path: '/usr/bin/chromium' }]);
  });
});

describe('describeBrowser', () => {
  it('names the browser, its path and its origin', () => {
    expect(describeBrowser({ name: 'Brave', path: 'C:\\b\\brave.exe', origin: 'detected' })).toBe(
      'Brave — C:\\b\\brave.exe (detected)',
    );
  });
});
