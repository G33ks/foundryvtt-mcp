/**
 * @fileoverview The checks `init` (and `init --check`) runs, each returning
 * a verdict with a message the user can act on.
 *
 * They connect the way the connector does — axios and socket.io-client with
 * Node's default TLS verification, the 4-step `/join` login of `auth.ts` —
 * but never start the module bridge: no bridge port is taken, so they run
 * next to a running shared process. No message carries a password.
 */

import axios, { type AxiosResponse } from 'axios';
import { io } from 'socket.io-client';
import {
  authenticateFoundry,
  isNoWorldPage,
  NoActiveWorldError,
  sessionSocketOptions,
} from '../foundry/auth.js';
import { type BrowserChoice, describeBrowser } from '../foundry/browser-detect.js';
import { gamemasterAccountWarning, roleLabel } from '../foundry/client.js';
import { USER_ROLES } from '../foundry/types.js';

/** Id of the companion module in FoundryVTT. */
export const BRIDGE_MODULE_ID = 'foundryvtt-mcp-bridge';

/** Stable manifest URL: always the latest bridge release. */
export const BRIDGE_MANIFEST_URL =
  'https://raw.githubusercontent.com/G33ks/foundryvtt-mcp/main/foundry-module/module.json';

export type Verdict<T = undefined> =
  | { ok: true; value: T; message: string; warning?: string }
  | { ok: false; message: string };

const REQUEST_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------------

function isLoopback(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '');
  return bare === 'localhost' || bare === '::1' || /^127\./.test(bare);
}

/**
 * The FoundryVTT base URL from what the user typed: a scheme added when
 * missing (http for this machine, https otherwise), trailing slashes and a
 * pasted `/join`, `/game` or `/setup` removed, a route prefix kept.
 */
export function normalizeUrl(input: string): Verdict<string> {
  let text = input.trim();
  if (text === '') {
    return { ok: false, message: 'Type the address of your FoundryVTT server.' };
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    const host = text.split(/[/:]/)[0] ?? '';
    text = `${isLoopback(host) ? 'http' : 'https'}://${text}`;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, message: `"${input.trim()}" is not a valid address.` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, message: 'The address must start with http:// or https://.' };
  }
  const pathname = url.pathname
    .replace(/\/+$/, '')
    .replace(/\/(join|game|setup|auth|license)$/, '');
  const value = `${url.protocol}//${url.host}${pathname}`;
  const warning =
    url.protocol === 'http:' && !isLoopback(url.hostname)
      ? 'This address uses plain http: the password would cross the network unencrypted. Use https for a remote server.'
      : undefined;
  return { ok: true, value, message: value, ...(warning ? { warning } : {}) };
}

// ---------------------------------------------------------------------------
// Network errors
// ---------------------------------------------------------------------------

const TLS_CODES: Record<string, string> = {
  CERT_HAS_EXPIRED: 'its certificate has expired',
  CERT_NOT_YET_VALID: 'its certificate is not valid yet (check this computer’s clock)',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'its certificate is self-signed',
  SELF_SIGNED_CERT_IN_CHAIN: 'its certificate chain ends in a self-signed certificate',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'its certificate cannot be verified (incomplete chain)',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'its certificate issuer is not trusted by Node.js',
  ERR_TLS_CERT_ALTNAME_INVALID: 'its certificate is for another name or address',
};

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const { code, cause } = error as { code?: unknown; cause?: unknown };
  if (typeof code === 'string' && code !== 'ERR_BAD_RESPONSE' && code !== 'ERR_BAD_REQUEST') {
    return code;
  }
  return cause !== undefined ? errorCode(cause) : undefined;
}

/** What went wrong reaching `url`, in words. */
export function describeNetworkError(url: string, error: unknown): string {
  const code = errorCode(error);
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  if (code && TLS_CODES[code]) {
    return (
      `The secure connection to ${host} was refused: ${TLS_CODES[code]} (${code}). ` +
      'The connector checks certificates like a browser: fix the certificate on the server ' +
      '(in FoundryVTT: Setup → Configuration → SSL), or give Node.js your own authority ' +
      'with NODE_EXTRA_CA_CERTS.'
    );
  }
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `${host} could not be found (${code}): check the spelling of the address.`;
    case 'ECONNREFUSED':
      return `${host} refused the connection (${code}): is FoundryVTT running, on this port?`;
    case 'ETIMEDOUT':
    case 'ECONNABORTED':
    case 'ENETUNREACH':
    case 'EHOSTUNREACH':
      return `${host} did not answer (${code}): check the address, the port and any firewall.`;
    case 'ECONNRESET':
    case 'EPROTO':
      return `${host} closed the connection (${code}): check http versus https in the address.`;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return `Could not reach ${host}: ${detail}`;
}

const NO_WORLD_MESSAGE =
  'FoundryVTT answers, but no world is running ("No Active Game"). Launch your world ' +
  'from the Setup screen, then press Enter to try again.';

// ---------------------------------------------------------------------------
// GET /join
// ---------------------------------------------------------------------------

type HttpGet = (url: string) => Promise<Pick<AxiosResponse, 'status' | 'headers' | 'data'>>;

const defaultGet: HttpGet = (url) =>
  axios.get(url, {
    maxRedirects: 0,
    timeout: REQUEST_TIMEOUT_MS,
    validateStatus: () => true,
    responseType: 'text',
  });

/** Reaches `<url>/join` and says whether a world is running there. */
export async function probeJoin(url: string, get: HttpGet = defaultGet): Promise<Verdict> {
  let response: Awaited<ReturnType<HttpGet>>;
  try {
    response = await get(`${url}/join`);
  } catch (error) {
    return { ok: false, message: describeNetworkError(url, error) };
  }
  const location = String(response.headers?.location ?? '');
  if (
    response.status >= 300 &&
    response.status < 400 &&
    /\/(setup|auth|license)\b/.test(location)
  ) {
    return { ok: false, message: NO_WORLD_MESSAGE };
  }
  if (response.status === 200 && isNoWorldPage(response.data)) {
    return { ok: false, message: NO_WORLD_MESSAGE };
  }
  const cookies = response.headers?.['set-cookie'];
  const hasSession = (Array.isArray(cookies) ? cookies.join(' ') : String(cookies ?? '')).includes(
    'session=',
  );
  if ((response.status === 200 || response.status === 302) && hasSession) {
    return {
      ok: true,
      value: undefined,
      message: `FoundryVTT answers at ${url}, with a world running.`,
    };
  }
  return {
    ok: false,
    message:
      `${url}/join answered HTTP ${response.status} without a FoundryVTT session: ` +
      'is this the address of FoundryVTT (and its route prefix, if any)?',
  };
}

// ---------------------------------------------------------------------------
// Login, role, module
// ---------------------------------------------------------------------------

export interface WorldModule {
  id?: unknown;
  version?: unknown;
  active?: unknown;
}

export interface WorldSnapshot {
  /** The account's role, `null` when the world did not say. */
  role: number | null;
  modules: WorldModule[];
}

/** Why the login failed, worded for the user; `retry` names what to change. */
export function describeLoginError(
  url: string,
  username: string,
  error: unknown,
): { message: string; retry: 'url' | 'account' | 'world' } {
  if (error instanceof NoActiveWorldError) {
    return { message: NO_WORLD_MESSAGE, retry: 'world' };
  }
  const text = error instanceof Error ? error.message : String(error);
  if (/^User ".*" not found$/.test(text)) {
    return {
      message:
        `There is no user named "${username}" in this world. Create it in FoundryVTT ` +
        '(Game Settings → Configure Players / User Management), or check the spelling.',
      retry: 'account',
    };
  }
  const auth = /authentication failed \(HTTP (\d+)\): (.*)$/s.exec(text);
  if (auth) {
    const reason = auth[2] ?? '';
    if (/password/i.test(reason)) {
      return { message: `Wrong password for "${username}".`, retry: 'account' };
    }
    return {
      message: `FoundryVTT refused the login of "${username}" (HTTP ${auth[1]}): ${reason}`,
      retry: 'account',
    };
  }
  return { message: describeNetworkError(url, error), retry: 'url' };
}

/** Logs in like the connector, then reads the account's role and the installed modules. */
export async function loginAndReadWorld(
  url: string,
  username: string,
  password: string,
): Promise<WorldSnapshot> {
  const { session, userId } = await authenticateFoundry(url, username, password);
  return await new Promise<WorldSnapshot>((resolve, reject) => {
    const socket = io(url, { ...sessionSocketOptions(session), reconnection: false });
    const finish = (outcome: () => void) => {
      clearTimeout(timer);
      socket.off('session', onSession);
      socket.off('connect_error', onError);
      socket.disconnect();
      outcome();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error('FoundryVTT did not send the world data in time'))),
      REQUEST_TIMEOUT_MS,
    );
    const onSession = () => {
      socket.emit('world', (data: { users?: unknown; modules?: unknown }) => {
        const users = Array.isArray(data?.users)
          ? (data.users as Array<{ _id?: unknown; role?: unknown }>)
          : [];
        const me = users.find((u) => u._id === userId);
        finish(() =>
          resolve({
            role: typeof me?.role === 'number' ? me.role : null,
            modules: Array.isArray(data?.modules) ? (data.modules as WorldModule[]) : [],
          }),
        );
      });
    };
    const onError = (error: Error) => finish(() => reject(error));
    socket.on('session', onSession);
    socket.on('connect_error', onError);
  });
}

/** Whether `role` can run the connector: the module and the headless page need `isGM`. */
export function evaluateRole(username: string, role: number | null): Verdict {
  if (role === null) {
    return {
      ok: true,
      value: undefined,
      message: `Logged in as "${username}".`,
      warning:
        'FoundryVTT did not report the role of this account: make sure it is an Assistant GM.',
    };
  }
  const label = roleLabel(role);
  if (role < USER_ROLES.assistant) {
    return {
      ok: false,
      message:
        `"${username}" is a ${label}: the companion module and the headless GM session need a GM ` +
        'role. Make this account an Assistant GM (Game Settings → User Management), then press ' +
        'Enter to try again.',
    };
  }
  const warning = gamemasterAccountWarning(true, { name: username, role }) ?? undefined;
  return {
    ok: true,
    value: undefined,
    message: `Logged in as "${username}" (${label}).`,
    ...(warning ? { warning } : {}),
  };
}

/** Whether the companion module is installed and enabled in the world. */
export function evaluateModule(modules: WorldModule[]): Verdict<string | null> {
  const bridge = modules.find((m) => m.id === BRIDGE_MODULE_ID);
  if (!bridge) {
    return {
      ok: false,
      message: [
        `The companion module ${BRIDGE_MODULE_ID} is not installed on this FoundryVTT server. To install it:`,
        '  1. In FoundryVTT, Return to Setup, then Add-on Modules → Install Module.',
        `  2. Paste this manifest URL and press Install: ${BRIDGE_MANIFEST_URL}`,
        '  3. Launch the world, open Game Settings → Manage Modules, tick "FoundryVTT MCP Bridge"',
        '     and Save Module Settings.',
        'Then press Enter here to check again.',
      ].join('\n'),
    };
  }
  const version = typeof bridge.version === 'string' ? bridge.version : null;
  const named = `${BRIDGE_MODULE_ID}${version ? ` v${version}` : ''}`;
  if (bridge.active !== true) {
    return {
      ok: false,
      message: [
        `The companion module ${named} is installed but not enabled in this world. To enable it:`,
        '  Game Settings → Manage Modules, tick "FoundryVTT MCP Bridge", then Save Module Settings',
        '  (the world reloads).',
        'Then press Enter here to check again.',
      ].join('\n'),
    };
  }
  return { ok: true, value: version, message: `Companion module ${named} installed and enabled.` };
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

/**
 * Launches the headless GM browser as the session would (headless, with a
 * throwaway profile), opens `about:blank` and closes it.
 */
export async function checkBrowser(
  executablePath: string | undefined,
): Promise<Verdict<BrowserChoice>> {
  const { launchHeadlessBrowser } = await import('../foundry/headless-gm-session.js');
  let launched: Awaited<ReturnType<typeof launchHeadlessBrowser>>;
  try {
    launched = await launchHeadlessBrowser(executablePath ? { executablePath } : {});
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  try {
    const page = await launched.browser.newPage();
    await page.goto('about:blank');
  } catch (error) {
    await launched.browser.close().catch(() => undefined);
    return {
      ok: false,
      message: `${describeBrowser(launched.choice)} started but could not open a page: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  await launched.browser.close();
  return {
    ok: true,
    value: launched.choice,
    message: `Browser for the headless GM session: ${describeBrowser(launched.choice)} — started and closed.`,
  };
}
