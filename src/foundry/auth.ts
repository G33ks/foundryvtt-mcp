/**
 * FoundryVTT authentication module
 *
 * Implements the proven 4-step authentication flow for direct WebSocket access:
 * 1. GET /join → session cookie
 * 2. Socket.IO connect + getJoinData → resolve user document _id
 * 3. POST /join as JSON with document _id → authenticated session
 * 4. Socket.IO reconnect with session → full game state access
 */

import axios from 'axios';
import type { ManagerOptions, SocketOptions } from 'socket.io-client';
import { io } from 'socket.io-client';
import { isRecord } from '../utils/guards.js';
import { logger } from '../utils/logger.js';
import { RefusedError } from '../utils/refusal.js';

/**
 * Socket.IO connection options carrying a FoundryVTT session.
 *
 * FoundryVTT resolves the session from the `session` **cookie** on the
 * handshake request; the `session` query parameter alone leaves the socket
 * anonymous. An anonymous socket still connects at the transport level — it
 * simply never answers `getJoinData` and emits `session` as `null` — so the
 * only symptom is a bare timeout with no `connect_error` (laurigates/foundryvtt-mcp#206).
 *
 * `extraHeaders` is honoured by socket.io-client in Node.js for both the
 * WebSocket and polling handshakes; the query parameter is kept for servers
 * that read it.
 */
export function sessionSocketOptions(session: string): Partial<ManagerOptions & SocketOptions> {
  return {
    transports: ['websocket'],
    query: { session },
    extraHeaders: { Cookie: `session=${session}` },
  };
}

/**
 * No world is launched: FoundryVTT sits on its Setup screen. Expected while
 * the GM has not launched one (e.g. after a server restart), so a refusal —
 * one warning line, no stack — and the next tool call retries.
 */
export class NoActiveWorldError extends RefusedError {
  override name = 'NoActiveWorldError';

  constructor() {
    super('No active world on FoundryVTT: launch it from the Setup screen.');
  }
}

/**
 * FoundryVTT v14's answer to GET and POST /join with no active world: its
 * "No Active Game" error page, HTTP 200 (dist/server/views/view.mjs `_noWorld`).
 * A hint only — English text that may change: the decision is
 * {@link fetchJoinUsers} returning no user list.
 */
export function isNoWorldPage(data: unknown): boolean {
  return (
    typeof data === 'string' &&
    /There is currently no active game session|<title>[^<]*No Active Game/i.test(data)
  );
}

/**
 * Extracts the session cookie value from a GET /join response, and whether
 * the response looked like the "No Active Game" page.
 */
async function getSessionCookie(
  baseUrl: string,
): Promise<{ session: string; noWorldPage: boolean }> {
  const res = await axios.get(`${baseUrl}/join`, {
    // Accept 200 (join page) and 302 (redirect after cookie set)
    validateStatus: (status) => status === 200 || status === 302,
    maxRedirects: 0,
  });

  const cookies = res.headers['set-cookie'];
  if (!cookies) {
    throw new Error('No session cookie returned from /join');
  }

  const cookieString = Array.isArray(cookies) ? cookies.join(' ') : cookies;
  const match = cookieString.match(/session=([^;]+)/);
  if (!match?.[1]) {
    throw new Error('Could not extract session cookie from response');
  }

  logger.debug('Session cookie obtained');
  return { session: match[1], noWorldPage: isNoWorldPage(res.data) };
}

interface JoinUser {
  _id: string;
  name: string;
}

/**
 * Asks FoundryVTT for its join data over Socket.IO (`getJoinData`).
 *
 * @returns the world's users, or `null` when the answer carries no user
 *   list — FoundryVTT answers `{}` when no world is active (join.mjs
 *   `handleSocket`), which is what decides {@link NoActiveWorldError}
 */
function fetchJoinUsers(baseUrl: string, session: string): Promise<JoinUser[] | null> {
  return new Promise((resolve, reject) => {
    const socket = io(baseUrl, sessionSocketOptions(session));

    const cleanup = () => {
      socket.off('session', onSession);
      socket.off('connect_error', onConnectError);
    };

    const timeout = setTimeout(() => {
      cleanup();
      socket.disconnect();
      reject(new Error('Timeout resolving user ID via getJoinData'));
    }, 10000);

    const onSession = () => {
      socket.emit('getJoinData', (data: { users?: JoinUser[] }) => {
        clearTimeout(timeout);
        cleanup();
        socket.disconnect();
        resolve(Array.isArray(data?.users) ? data.users : null);
      });
    };

    const onConnectError = (err: Error) => {
      clearTimeout(timeout);
      cleanup();
      socket.disconnect();
      reject(new Error(`Socket.IO connection failed during user resolution: ${err.message}`));
    };

    socket.on('session', onSession);
    socket.on('connect_error', onConnectError);
  });
}

/**
 * A /join response looked like the "No Active Game" page: confirm with
 * `getJoinData` before saying so.
 *
 * @throws {NoActiveWorldError} getJoinData returned no user list
 */
async function confirmNoActiveWorld(baseUrl: string, session: string): Promise<void> {
  if ((await fetchJoinUsers(baseUrl, session)) === null) {
    throw new NoActiveWorldError();
  }
}

/**
 * Resolves a user identifier to a FoundryVTT document _id.
 *
 * If the input is already a 16-character alphanumeric string (document _id format),
 * returns it directly. Otherwise, connects via Socket.IO and emits getJoinData
 * to look up the _id by display name.
 *
 * @throws {NoActiveWorldError} getJoinData returned no user list
 */
async function resolveUserId(baseUrl: string, user: string, session: string): Promise<string> {
  // FoundryVTT document IDs are 16-character alphanumeric strings
  if (/^[a-zA-Z0-9]{16}$/.test(user)) {
    logger.debug('User identifier is already a document _id', { userId: user });
    return user;
  }

  logger.debug('Resolving display name to document _id', { displayName: user });

  const users = await fetchJoinUsers(baseUrl, session);
  if (users === null) {
    throw new NoActiveWorldError();
  }
  const found = users.find((u) => u.name.toLowerCase() === user.toLowerCase());
  if (!found) {
    const available = users.map((u) => u.name).join(', ');
    logger.debug('User not found in FoundryVTT user list', { available });
    throw new Error(`User "${user}" not found`);
  }

  logger.debug('Resolved user document _id', { displayName: user, _id: found._id });
  return found._id;
}

/** A redirect path as FoundryVTT gives it, without its query or fragment. */
function redirectPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) {
    return undefined;
  }
  return value.split(/[?#]/, 1)[0] || undefined;
}

/**
 * Logs the HTTP status of a POST /join answer and where it redirects to,
 * for diagnosis after a FoundryVTT update. Never the headers (cookie), the
 * body or the request.
 */
function logJoinAnswer(response: { status?: unknown; data?: unknown; headers?: unknown }): void {
  if (typeof response.status !== 'number') {
    return;
  }
  const data = response.data;
  const redirect =
    redirectPath(isRecord(data) ? data.redirect : undefined) ??
    redirectPath(isRecord(response.headers) ? response.headers.location : undefined);
  logger.info('POST /join answered', {
    status: response.status,
    ...(redirect ? { redirect } : {}),
  });
}

/** `axios.post` that logs the status of the answer, including one axios throws on. */
async function postJoin(...args: Parameters<typeof axios.post>) {
  try {
    const response = await axios.post(...args);
    logJoinAnswer(response);
    return response;
  } catch (error) {
    if (isRecord(error) && isRecord(error.response)) {
      logJoinAnswer(error.response);
    }
    throw error;
  }
}

/**
 * Authenticates with FoundryVTT using the proven 4-step flow.
 *
 * @returns Session cookie and resolved user document _id
 */
export async function authenticateFoundry(
  baseUrl: string,
  user: string,
  password: string,
): Promise<{ session: string; userId: string }> {
  // Warn when credentials are sent over plaintext HTTP to a non-localhost host
  try {
    const parsed = new URL(baseUrl);
    // new URL('http://[::1]').hostname returns the bracketed form '[::1]';
    // strip IPv6 brackets so loopback comparison is uniform.
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    if (parsed.protocol === 'http:' && !isLocalhost) {
      logger.warn(
        'WARNING: Connecting to a non-localhost host over plain HTTP. ' +
          'Your password will be transmitted in plaintext. ' +
          'Use HTTPS for non-local FoundryVTT instances.',
        { host: parsed.hostname },
      );
    }
  } catch {
    // URL already validated by config; ignore parse errors here
  }

  // Step 1: Get session cookie
  const { session, noWorldPage } = await getSessionCookie(baseUrl);
  // The getJoinData lookup below decides on its own; a FOUNDRY_USER_ID skips
  // it, so confirm a "No Active Game" page with it here.
  if (noWorldPage && /^[a-zA-Z0-9]{16}$/.test(user)) {
    await confirmNoActiveWorld(baseUrl, session);
  }

  // Step 2: Resolve user to document _id
  const userId = await resolveUserId(baseUrl, user, session);

  // Step 3: POST /join as JSON with document _id
  const joinRes = await postJoin(
    `${baseUrl}/join`,
    {
      action: 'join',
      userid: userId, // Foundry v13
      userId, // Foundry v14 reads camelCase
      password,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        Cookie: `session=${session}`,
        // FoundryVTT v14 rejects POST /join without an Origin header (HTTP 400),
        // so send the server's own origin as a browser would.
        Origin: new URL(baseUrl).origin,
        // Some FoundryVTT v14 setups reject the join POST (HTTP 400) unless it
        // carries Sec-Fetch-Site: same-origin, as a browser's same-origin fetch
        // does (reported on 14.369). Origin alone is enough on others, so send both.
        'Sec-Fetch-Site': 'same-origin',
      },
      // Accept 200 (success JSON), 302 (redirect to /game on success) and 401
      // (bad password). 401 carries FoundryVTT's own explanation in the body;
      // letting axios throw on it would surface a bare
      // "Request failed with status code 401" instead (laurigates/foundryvtt-mcp#206).
      validateStatus: (status) => status === 200 || status === 302 || status === 401,
    },
  );

  if (isNoWorldPage(joinRes.data)) {
    await confirmNoActiveWorld(baseUrl, session);
  }
  if (joinRes.data?.status !== 'success' && joinRes.data?.redirect !== '/game') {
    // FoundryVTT v13+ answers a rejected /join with a plain-text i18n key
    // (e.g. "JOIN.ErrorInvalidPassword") rather than a JSON error object.
    const msg =
      (typeof joinRes.data === 'string' && joinRes.data.trim()) ||
      joinRes.data?.message ||
      joinRes.data?.error ||
      'Unknown error';
    throw new Error(`FoundryVTT authentication failed (HTTP ${joinRes.status}): ${msg}`);
  }

  logger.info('FoundryVTT authentication successful', { userId });
  return { session, userId };
}
