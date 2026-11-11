/**
 * FoundryVTT client for API communication via Socket.IO
 *
 * Connects to FoundryVTT using the proven 4-step authentication flow,
 * caches worldData in memory, and serves all queries from the snapshot.
 */

import { type Dirent, readdirSync } from 'node:fs';
import {
  join as pathJoin,
  relative as pathRelative,
  resolve as pathResolve,
  sep as pathSep,
} from 'node:path';
import axios, { type AxiosInstance, type AxiosRequestConfig, type AxiosResponse } from 'axios';
import { io, type Socket } from 'socket.io-client';
import { z } from 'zod';
import { defaultStateDir } from '../shared/paths.js';
import { isRecord } from '../utils/guards.js';
import { getImageSize, type ImageSize } from '../utils/image-size.js';
import { logger } from '../utils/logger.js';
import { RefusedError } from '../utils/refusal.js';
import { authenticateFoundry, NoActiveWorldError, sessionSocketOptions } from './auth.js';
import { evaluateDiceFormula } from './dice-formula.js';
import type { EventFilter, EventReadResult } from './event-log.js';
import { summarizeDocumentBroadcast, WorldEventLog } from './event-log.js';
import { JournalConflictFile } from './journal-conflicts.js';
import { JournalHistory } from './journal-history.js';
import {
  conflictAuthor,
  type ForeignChange,
  JOURNAL_CONFLICT_SPEAKER,
  type JournalConflict,
  JournalWatch,
  journalConflictMessage,
  journalContribution,
  journalVersion,
  OVERWRITTEN_BY_CONNECTOR,
  RECENT_AUTOSAVE_MS,
} from './journal-integrity.js';
import type {
  ActorAttributeUpdateResult,
  ActorEffectInput,
  ActorItemCreateSource,
  ActorSearchResult,
  CompendiumSearchResult,
  DiceRoll,
  DocumentVisibility,
  FoundryActor,
  FoundryItem,
  FoundryScene,
  FoundryWorld,
  ItemSearchResult,
  JournalEntryUpdate,
  JournalPageCreateSource,
  JournalPageUpdate,
  JournalPageWriteResult,
  WorldActor,
  WorldCombat,
  WorldData,
  WorldEffect,
  WorldItem,
  WorldJournal,
  WorldJournalPage,
  WorldMessage,
  WorldScene,
  WorldUser,
} from './types.js';
import { ACTIVE_EFFECT_MODES, OWNERSHIP_LEVELS, USER_ROLES, VISIBILITY_LEVELS } from './types.js';
import {
  applyDocumentBroadcast,
  applyUserActivity,
  type DocumentBroadcast,
  mergePatch,
  parseDocumentBatch,
  parseDocumentBroadcast,
  parseUserActivity,
} from './world-cache.js';

/** Who overwrote a page when an editor autosave did: FoundryVTT does not say. */
const EDITOR_AUTOSAVE_USER = 'editor-autosave (unknown user)';

/** FoundryVTT document IDs are 16-character alphanumeric strings. */
const FOUNDRY_ID_PATTERN = /^[a-zA-Z0-9]{16}$/;

/** A journal entry as read back from the server by {@link FoundryClient.fetchJournalEntry}. */
const FetchedJournalSchema = z
  .object({
    _id: z.string(),
    name: z.string(),
    pages: z.array(
      z
        .object({
          _id: z.string(),
          name: z.string(),
          type: z.string(),
          sort: z.number().optional(),
          // Non-text pages carry `text.content: null`.
          text: z
            .object({
              content: z
                .string()
                .nullish()
                .transform((content) => content ?? ''),
              format: z.number().catch(1),
            })
            .passthrough()
            .optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

/** Extensions {@link FoundryClient.listSceneAssets} treats as browsable image assets. */
const IMAGE_EXTENSION_PATTERN = /\.(png|jpe?g|webp)$/i;

/** Extensions {@link FoundryClient.listSceneAssets} treats as browsable audio assets. */
const AUDIO_EXTENSION_PATTERN = /\.(mp3|ogg|wav|m4a|flac|opus|webm)$/i;

/** 6-digit hex color pattern used by Foundry ColorField. */
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** Document types that can be organized into Folders. */
const FOLDER_DOCUMENT_TYPES = [
  'Actor',
  'Adventure',
  'Item',
  'Scene',
  'JournalEntry',
  'Playlist',
  'RollTable',
  'Cards',
  'Macro',
  'Compendium',
] as const;
/**
 * `type` option for {@link FoundryClient.createWall}, matching FoundryVTT's
 * own named wall presets (the ones its wall-tool palette offers), not an
 * invented vocabulary:
 *  - `wall` — solid: blocks movement and sight (Foundry's schema default)
 *  - `door` / `secretDoor` — openable via {@link FoundryClient.setDoorState}
 *  - `terrain` — blocks movement, but sight only blocks on the *second*
 *    crossing (WALL_SENSE_TYPES.LIMITED) — hedges, foliage: you can see the
 *    hedge but not what is directly behind it
 *  - `invisible` — blocks movement, not sight (furniture, low obstacles,
 *    hidden traps)
 *  - `ethereal` — the inverse of `invisible`: blocks sight, not movement
 *    (magical curtains, spectral barriers)
 */
export type WallType = 'wall' | 'door' | 'secretDoor' | 'terrain' | 'invisible' | 'ethereal';

/**
 * Wall field presets for {@link FoundryClient.createWall}'s `type` option.
 * A plain "wall" sets no fields, relying on Foundry's own Wall schema
 * defaults (blocks movement and sight). `WALL_SENSE_TYPES`/`WALL_MOVEMENT_TYPES`
 * NONE (0) and LIMITED (10) are hardcoded here — both are stable across the
 * Foundry versions this project supports (v13 and v14; v14 build 369 keeps
 * them as `EDGE_SENSE_TYPES`, `WALL_SENSE_TYPES` being its deprecated alias) — but no
 * preset touches the exact "blocking" (NORMAL) value, which is left to the
 * server's own schema default rather than guessed.
 */
const WALL_TYPE_PRESETS: Record<WallType, Record<string, number>> = {
  wall: {},
  door: { door: 1, ds: 0 },
  secretDoor: { door: 2, ds: 0 },
  terrain: { sight: 10 },
  invisible: { sight: 0 },
  ethereal: { move: 0 },
};

/**
 * Characters a dice formula may contain. A cheap sanity gate, not a grammar:
 * it rejects Foundry modifier syntax (`4d6kh3`), attribute references
 * (`1d20+STR`) and arithmetic this server never forwards (`*`, `/`), while
 * still allowing parentheses through to FoundryVTT's own `Roll` engine on the
 * REST transport. See {@link FoundryClient.rollDice}.
 */
const DICE_FORMULA_ALPHABET = /^[0-9d\s+\-()]+$/;

/** Single-character form of {@link DICE_FORMULA_ALPHABET}, for locating a violation. */
const DICE_FORMULA_CHARACTER = /[0-9d\s+\-()]/;

/** Upper bound on formula length, common to both transports. */
const MAX_DICE_FORMULA_LENGTH = 100;

/**
 * Builds the REST-path rejection for a formula outside the dice alphabet.
 *
 * The local parser cannot be borrowed for this: it rejects parentheses, which
 * REST *does* support, so for `(1d20+5)*2` it would name the wrong problem.
 * This scans for the first character the alphabet does not admit and reports
 * it by name and position, so the REST path is as specific about what it
 * refused as the local one (laurigates/foundryvtt-mcp#219).
 */
function alphabetViolation(formula: string): Error {
  if (formula === '') {
    return new Error('Invalid dice formula: the formula is empty.');
  }
  const index = [...formula].findIndex((char) => !DICE_FORMULA_CHARACTER.test(char));
  if (index === -1) {
    return new Error(`Invalid dice formula: ${formula}`);
  }
  return new Error(
    `Invalid dice formula "${formula}": unexpected "${formula[index]}" at position ${index}. ` +
      'Supported syntax: dice terms (NdS, or dS for a single die) and whole numbers, joined by ' +
      '+ or -, optionally grouped in parentheses.',
  );
}

/**
 * True when a rejected request carries an HTTP response — FoundryVTT answered,
 * whatever the status. A rejection without one is a transport failure
 * (connection refused or reset, DNS, timeout): the server is not reachable.
 *
 * Read reflectively rather than cast, so a non-axios rejection cannot be
 * mistaken for a reply.
 */
function hasHttpResponse(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const response = Reflect.get(error, 'response');
  return response !== undefined && response !== null;
}

/**
 * Maps {@link ActorEffectInput.changes} mode names to FoundryVTT's numeric
 * `CONST.ACTIVE_EFFECT_MODES`, throwing on an unrecognized name rather than
 * forwarding `NaN` or an arbitrary number to the wire.
 */
function mapEffectChanges(
  changes: ActorEffectInput['changes'],
): Array<{ key: string; mode: number; value: string; priority?: number }> | undefined {
  if (!changes) {
    return undefined;
  }
  return changes.map((change) => {
    const mode = ACTIVE_EFFECT_MODES[change.mode];
    if (mode === undefined) {
      throw new Error(
        `Invalid effect change mode "${change.mode}": expected one of ${Object.keys(ACTIVE_EFFECT_MODES).join(', ')}`,
      );
    }
    const mapped: { key: string; mode: number; value: string; priority?: number } = {
      key: change.key,
      mode,
      value: change.value,
    };
    if (change.priority !== undefined) {
      mapped.priority = change.priority;
    }
    return mapped;
  });
}

/**
 * Spacing between sibling `sort` values, mirroring Foundry's
 * `CONST.SORT_INTEGER_DENSITY`. Leaving every sibling at the default `0` makes
 * ordering depend on incidental collection insertion order, and gives Foundry
 * no gap to slot a UI-created sibling into later.
 */
const SORT_INTEGER_DENSITY = 100000;

/** One token on a scene, whose actor an actor write addresses instead of the world actor. */
export interface ActorTokenRef {
  sceneId: string;
  tokenId: string;
}

/**
 * Accepts the two parent-UUID forms a token's actor can take:
 *  - `Actor.<id>` — a world-linked actor (`actorLink: true`)
 *  - `Scene.<sid>.Token.<tid>.Actor.<aid>` — an unlinked token's synthetic actor
 */
const TOKEN_ACTOR_UUID_PATTERN =
  /^(Actor\.[a-zA-Z0-9]{16}|Scene\.[a-zA-Z0-9]{16}\.Token\.[a-zA-Z0-9]{16}\.Actor\.[a-zA-Z0-9]{16})$/;

/**
 * Minimal Zod schema for the `/api/dice/roll` REST response.
 *
 * The REST module is external input, so the body is validated rather than read
 * off an `any`: a 200 whose payload carries no numeric `total` would otherwise
 * produce a `DiceRoll` with `total: undefined` while the type claims `number`,
 * and `roll_dice` would render that straight to the caller. A body that does
 * not match is treated like any other REST failure and falls through to the
 * local roller.
 */
const RestDiceRollSchema = z.object({
  total: z.number(),
  terms: z.array(z.object({ results: z.array(z.number()).optional() })).optional(),
});

/**
 * Minimal Zod schema for the WorldData Socket.IO payload.
 * Validates the required top-level array fields; extra fields pass through.
 */
const WorldDataSchema = z.object({
  userId: z.string(),
  actors: z.array(z.unknown()),
  scenes: z.array(z.unknown()),
  items: z.array(z.unknown()),
  journal: z.array(z.unknown()),
  messages: z.array(z.unknown()),
  combats: z.array(z.unknown()),
  users: z.array(z.unknown()),
  activeUsers: z.array(z.string()),
  macros: z.array(z.unknown()),
  playlists: z.array(z.unknown()),
  tables: z.array(z.unknown()),
  folders: z.array(z.unknown()),
});

export interface FoundryClientConfig {
  baseUrl: string;
  apiKey?: string;
  username?: string;
  password?: string;
  userId?: string;
  timeout?: number;
  retryAttempts?: number;
  retryDelay?: number;
  socketPath?: string;
  /** Opt-in gate for game-state mutations (FOUNDRY_WRITE_ENABLED). Default false. */
  writeEnabled?: boolean;
  /**
   * Absolute filesystem path to FoundryVTT's `Data` directory (FOUNDRY_DATA_PATH).
   * Optional: only set when this server runs on the same host as FoundryVTT.
   * Backs `list_scene_assets` and lets `create_scene`/`create_tile` read an
   * image's real pixel dimensions from disk instead of requiring the caller
   * to supply them.
   */
  dataPath?: string;
  /**
   * Capacity of the in-memory world-event ring backing `watch_events`
   * (FOUNDRY_EVENT_BUFFER_SIZE). Defaults to 500 when unset.
   */
  eventBufferSize?: number;
  /**
   * Folder for local copies of journal pages (see journal-history.ts).
   * Defaults to `journal-history` in the shared-process state directory.
   */
  journalHistoryDir?: string;
  /**
   * File keeping the detected journal overwrites across restarts (see
   * journal-conflicts.ts). Without it, the list lives in memory only.
   */
  journalConflictsFile?: string;
  /**
   * Usernames of the connector's other sessions (the headless GM). Their
   * changes are the connector's own and never count as overwrites.
   */
  connectorUsernames?: string[];
}

/** Minimal shape of FoundryVTT's `modifyDocument` Socket.IO acknowledgement. */
interface DocumentSocketResponse {
  /** Created/updated data objects, or deleted ids, on success. */
  result?: unknown[];
  /** Present when the server rejects the operation. */
  error?: { message?: string } | null;
  userId?: string;
  /** Instead of the fields above when the operation had side effects: side effects first, the operation last. */
  results?: unknown[];
}

export interface SearchActorsParams {
  query?: string;
  type?: string;
  limit?: number;
  cursor?: string;
}

export interface SearchItemsParams {
  query?: string;
  type?: string;
  rarity?: string;
  limit?: number;
  cursor?: string;
}

export interface CompendiumSearchParams {
  query?: string;
  packType?: string;
  itemType?: string;
  spellLevel?: number;
  source?: string;
  compendiumId?: string;
  limit?: number;
  /** Opaque pagination cursor from a prior result's `nextCursor`. */
  cursor?: string;
}

/**
 * Shallow attribute patch for {@link FoundryClient.updateActorAttribute} (laurigates/foundryvtt-mcp#143).
 *
 * Keys are dot-paths into the actor's `system` object (e.g.
 * `attributes.hp.value`, `currency.gp`, `spells.spell1.value`,
 * `attributes.exhaustion`). Values are the scalar to set at that path.
 */
export type AttributePatch = Record<string, number | string | boolean>;

/**
 * One entry returned by {@link FoundryClient.listTokens}: a Token document's
 * display-relevant fields, flattened out of the raw worldData record.
 */
export interface SceneToken {
  id: string;
  name: string;
  actorId: string | null;
  actorLink: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  elevation: number;
  rotation: number;
  hidden: boolean;
  disposition: number;
}

/**
 * One entry returned by {@link FoundryClient.listLights}.
 */
export interface SceneLight {
  id: string;
  x: number;
  y: number;
  rotation: number;
  walls: boolean;
  vision: boolean;
  hidden: boolean;
  dim: number;
  bright: number;

  color: string | null;
  angle: number;
  animationType: string | null;
}

/**
 * One entry returned by {@link FoundryClient.listSounds}.
 */
export interface SceneSound {
  id: string;
  x: number;
  y: number;
  radius: number;
  path: string;
  repeat: boolean;
  volume: number;
  walls: boolean;
  easing: boolean;
  hidden: boolean;
}

/**
 * One entry returned by {@link FoundryClient.listNotes}.
 */
export interface SceneNote {
  id: string;
  entryId: string | null;
  pageId: string | null;
  x: number;
  y: number;
  text: string;
  iconSize: number;
  fontSize: number;
  textAnchor: number;
  global: boolean;
}

/**
 * One entry returned by {@link FoundryClient.listDrawings}.
 */
export interface SceneDrawing {
  id: string;
  shapeType: string;
  x: number;
  y: number;
  width: number | null;
  height: number | null;
  radius: number | null;
  points: number[];
  rotation: number;
  strokeColor: string | null;
  fillType: number;
  fillColor: string | null;
  text: string;
  fontSize: number;
  hidden: boolean;
  locked: boolean;
}

/**
 * One entry returned by {@link FoundryClient.listTemplates}.
 */
export interface SceneTemplate {
  id: string;
  t: string;
  x: number;
  y: number;
  distance: number;
  direction: number;
  angle: number;
  width: number;
  borderColor: string | null;
  fillColor: string | null;
  hidden: boolean;
}

/**
 * One entry returned by {@link FoundryClient.listRegions} (FoundryVTT v12+).
 */
export interface SceneRegion {
  id: string;
  name: string;
  color: string | null;
  elevation: { bottom: number | null; top: number | null };
  shapesCount: number;
  behaviorsCount: number;
}

/**
 * One entry returned by {@link FoundryClient.listFolders}.
 */
export interface WorldFolderEntry {
  id: string;
  name: string;
  type: string;
  parent: string | null;
  color: string | null;
}

/**
 * One entry returned by {@link FoundryClient.listMacros}.
 */
export interface WorldMacroEntry {
  id: string;
  name: string;
  type: string;
  scope: string;
  folder: string | null;
  commandPreview: string;
}

/**
 * One entry returned by {@link FoundryClient.listPlaylists}.
 */
export interface WorldPlaylistEntry {
  id: string;
  name: string;
  playing: boolean;
  mode: number;
  channel: string;
  soundCount: number;
  sounds: Array<{
    id: string;
    name: string;
    path: string;
    playing: boolean;
    volume: number;
  }>;
}

/**
 * State of the authenticated Socket.IO link (Socket.IO mode only).
 *
 * - `connected`: the socket is up and FoundryVTT knows its session's user.
 * - `disconnected`: never connected yet, or the transport dropped and
 *   socket.io-client is reconnecting on its own.
 * - `reauthenticating`: a fresh `/join` authentication is in flight.
 * - `waiting-for-world`: the last attempt found no active world; retrying.
 * - `retrying`: the last attempt failed for another reason; retrying.
 */
export type ConnectionState =
  | 'connected'
  | 'disconnected'
  | 'reauthenticating'
  | 'waiting-for-world'
  | 'retrying';

/** {@link FoundryClient.connectionStatus}. */
export interface ConnectionStatus {
  state: ConnectionState;
  /** Why the link is not connected, when known; `null` while connected. */
  error: string | null;
}

/** First wait before retrying a failed reauthentication; doubles up to the cap. */
export const REAUTH_BASE_RETRY_MS = 5000;
/** Longest wait between two reauthentication attempts. */
export const REAUTH_MAX_RETRY_MS = 120_000;
/**
 * How long to wait for FoundryVTT's `world` payload. It is the whole world in
 * one message: about 10 s for an imported adventure with ~850 actors, which
 * the old 10-15 s limits cut off.
 */
const WORLD_LOAD_TIMEOUT_MS = 60_000;
/**
 * Most cache changes kept while a world reload runs, to replay onto the new
 * snapshot. Past it the replay is abandoned and the cache stays stale.
 */
export const WORLD_REPLAY_MAX_CHANGES = 10_000;

/** Why the cache is stale after a replay that overflowed. */
const REPLAY_OVERFLOW_REASON = `more than ${WORLD_REPLAY_MAX_CHANGES} changes arrived while the world data was loading`;

/** Cache changes kept while a world reload runs; see `FoundryClient.changeCache`. */
interface WorldReplay {
  changes: Array<(worldData: WorldData) => unknown>;
  /** More than {@link WORLD_REPLAY_MAX_CHANGES}: `changes` was dropped. */
  overflowed: boolean;
}

/** States in which the current session is known to be unusable. */
const SESSION_LOST_STATES: ReadonlySet<ConnectionState> = new Set([
  'reauthenticating',
  'waiting-for-world',
  'retrying',
]);

/** FoundryVTT's labels for `CONST.USER_ROLES`. */
const ROLE_LABELS: Record<number, string> = {
  0: 'None',
  1: 'Player',
  2: 'Trusted Player',
  3: 'Assistant GM',
  4: 'Gamemaster',
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * During a socket outage, a failed reconnection attempt is logged at most
 * once per this interval — or at once when its message changes.
 */
export const RECONNECT_ERROR_LOG_INTERVAL_MS = 60_000;

/** Longest reconnection error text kept for the log. */
const CONNECT_ERROR_MAX_LENGTH = 300;

/**
 * Hides a session cookie in a text bound for the log. The socket URL
 * carries it in its query (`?session=…`), and the cookie header as
 * `session=…`: a transport error that quotes either must not leak it.
 */
export function redactSession(text: string): string {
  return text.replace(/session=[^&\s;,"')]+/gi, 'session=<redacted>');
}

/**
 * One line for a socket.io `connect_error`: its message, plus the message of
 * the underlying transport error when it has one (e.g. "websocket error
 * (getaddrinfo ENOTFOUND …)"). Never the error object itself, which holds
 * the WebSocket and its URL. Session cookies are masked.
 */
export function describeConnectError(error: unknown): string {
  const message = errorMessage(error);
  const description = isRecord(error) ? error.description : undefined;
  const detail =
    typeof description === 'string'
      ? description
      : isRecord(description) && typeof description.message === 'string'
        ? description.message
        : undefined;
  const text = detail && detail !== message ? `${message} (${detail})` : message;
  return redactSession(text).slice(0, CONNECT_ERROR_MAX_LENGTH);
}

/** Label of a FoundryVTT user role, e.g. `Assistant GM`. */
export function roleLabel(role: number): string {
  return ROLE_LABELS[role] ?? `role ${role}`;
}

/**
 * Shared mode with a Gamemaster account: the page is a real browser client,
 * so it can become `game.users.activeGM` instead of a human Gamemaster
 * (equal roles fall back to the smaller user id) and run the system's
 * automations. `null` when there is nothing to warn about.
 */
export function gamemasterAccountWarning(
  shared: boolean,
  account: { name: string; role: number | null } | null,
): string | null {
  if (!shared || account?.role !== USER_ROLES.gamemaster) {
    return null;
  }
  return (
    `The connector's account "${account.name}" is a Gamemaster and the headless GM page shares ` +
    'it: that page may become the active GM instead of a human Gamemaster (equal roles go to ' +
    'the smaller user id) and run the game system automations. Make this account an Assistant GM.'
  );
}

export class FoundryClient {
  private http: AxiosInstance;
  private socket: Socket | null = null;
  private config: FoundryClientConfig;
  private _isConnected = false;
  /** Cookie of the current FoundryVTT session. Never logged. */
  private session: string | null = null;
  private readonly sessionListeners = new Set<(session: string) => void>();
  private connectionState: ConnectionState = 'disconnected';
  private connectionError: string | null = null;
  /** State and error last written to the log, so a retry loop logs once. */
  private loggedConnection: string | null = null;
  private readonly connectionWaiters = new Set<() => void>();
  private reauthInFlight: Promise<void> | null = null;
  private reauthTimer: NodeJS.Timeout | null = null;
  private reauthDelayMs = REAUTH_BASE_RETRY_MS;
  /** Set by `disconnect()`: no reauthentication may start after it. */
  private stopped = false;
  /** The transport reconnected; FoundryVTT's `session` answer is pending. */
  private awaitingSession = false;
  private worldData: WorldData | null = null;
  /** Set when the socket drops with a cache still loaded (laurigates/foundryvtt-mcp#217). */
  private worldDataStale = false;
  /** Since when, and why, the cache is stale ({@link markWorldDataStale}); `null` when fresh. */
  private worldDataStaleSince: Date | null = null;
  private worldDataStaleReason: string | null = null;
  /** The world reload running, shared by every caller of {@link refreshWorldData}. */
  private worldReload: Promise<void> | null = null;
  /** Rejects the running reload and clears its timer; set while one waits for its answer. */
  private cancelWorldReload: ((reason: string) => void) | null = null;
  /**
   * Cache changes made while a snapshot loads (first load or reload),
   * replayed onto it ({@link changeCache}); `null` when none loads.
   */
  private worldReplay: WorldReplay | null = null;
  /** Journal entries autosaved while the socket could not be asked; re-read once it can. */
  private readonly autosavedDuringLoad = new Set<string>();
  /**
   * The socket transport's current outage: since when, how many
   * reconnection attempts failed, and the last one logged. `null` while up.
   */
  private outage: {
    since: number;
    failedAttempts: number;
    loggedAt: number;
    loggedMessage: string | null;
  } | null = null;
  /** Counts socket drops: a reload that saw one leaves the cache stale. */
  private socketDrops = 0;
  /**
   * Last observed outcome of a REST request: false once one failed to reach
   * FoundryVTT at all (laurigates/foundryvtt-mcp#217). Unused in Socket.IO mode.
   */
  private restLinkLive = true;
  /** Records every observed document/presence/module broadcast for `watch_events`. */
  private readonly eventLog: WorldEventLog;
  /** Journal page writes in flight and watched, editor autosaves, pending warnings. */
  private readonly journalWatch: JournalWatch;
  /** Local copies of journal page bodies. */
  private readonly journalHistory: JournalHistory;
  /**
   * Called once per detected journal overwrite, after it is logged, copied
   * and queued as a warning. The owner uses it to whisper the GMs through
   * the write queue.
   */
  onJournalConflict: ((conflict: JournalConflict) => void) | null = null;

  constructor(config: FoundryClientConfig) {
    if (!config.baseUrl || config.baseUrl.trim() === '') {
      throw new Error('baseUrl is required and cannot be empty');
    }

    try {
      new URL(config.baseUrl);
    } catch {
      throw new Error(`Invalid baseUrl: ${config.baseUrl}`);
    }

    this.config = {
      timeout: 10000,
      retryAttempts: 3,
      retryDelay: 1000,
      socketPath: '/socket.io/',
      ...config,
    };
    this.eventLog = new WorldEventLog(config.eventBufferSize ?? 500);
    this.journalWatch = new JournalWatch(
      Date.now,
      config.journalConflictsFile ? new JournalConflictFile(config.journalConflictsFile) : null,
    );
    this.journalHistory = new JournalHistory(
      config.journalHistoryDir ?? pathJoin(defaultStateDir(), 'journal-history'),
    );

    this.http = axios.create({
      baseURL: this.config.baseUrl,
      timeout: this.config.timeout || 30000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'FoundryMCP/0.2.0',
      },
      maxRedirects: 3,
      maxContentLength: 50 * 1024 * 1024,
      maxBodyLength: 50 * 1024 * 1024,
      validateStatus: (status) => status >= 200 && status < 300,
    });

    if (this.config.apiKey) {
      this.http.interceptors.request.use((reqConfig) => {
        reqConfig.headers['x-api-key'] = this.config.apiKey;
        return reqConfig;
      });

      // REST mode has no socket to ask about liveness, so every request that
      // does happen doubles as the probe (laurigates/foundryvtt-mcp#217). See `isConnected()`.
      this.http.interceptors.response.use(
        (response) => {
          this.restLinkLive = true;
          return response;
        },
        (error: unknown) => {
          this.restLinkLive = hasHttpResponse(error);
          return Promise.reject(error);
        },
      );
    }

    const hasSocketCredentials = Boolean(
      (this.config.userId || this.config.username) && this.config.password,
    );
    const modes = [
      ...(this.config.apiKey ? ['REST API'] : []),
      ...(hasSocketCredentials ? ['Socket.IO'] : []),
    ];
    const mode = modes.length > 0 ? modes.join(' + ') : 'unconfigured';
    logger.info(`FoundryVTT client initialized (${mode} mode)`);
  }

  /**
   * Connects to FoundryVTT.
   *
   * The two transports are additive, not exclusive (see `.env.example`:
   * `FOUNDRY_API_KEY` is documented as "Optional: Diagnostics... to enable 5
   * server monitoring tools" — a supplement to Socket.IO, not a replacement
   * for it). When both are configured:
   *  - REST (`/api/status`) backs the 5 diagnostics tools.
   *  - Socket.IO remains the primary transport for everything else (reads
   *    from cached `worldData`, all WRITE mutations) — `assertWriteable`
   *    and every `list*`/`get*` accessor need the socket, not the API key.
   * A REST failure is non-fatal when Socket.IO credentials are also present
   * (diagnostics tools degrade; the rest of the server still works) — the
   * reverse is not true, since Socket.IO is what most tools depend on.
   */
  async connect(): Promise<void> {
    const user = this.config.userId || this.config.username;
    const password = this.config.password;

    if (!this.config.apiKey && !(user && password)) {
      throw new Error(
        'Socket.IO mode requires username/userId and password. ' +
          'Set FOUNDRY_USERNAME + FOUNDRY_PASSWORD or FOUNDRY_USER_ID + FOUNDRY_PASSWORD.',
      );
    }

    if (this.config.apiKey) {
      try {
        await this.http.get('/api/status');
        logger.info('Connected to FoundryVTT via REST API module (diagnostics)');
      } catch (error) {
        if (!(user && password)) {
          logger.error('Failed to connect via REST API module:', error);
          throw error;
        }
        logger.warn(
          'REST API module unreachable — diagnostics tools unavailable; continuing with Socket.IO',
          { error: error instanceof Error ? error.message : String(error) },
        );
      }
    }

    if (user && password) {
      this.stopped = false;
      try {
        await this.establishSession(user, password);
      } catch (error) {
        this.connectionError = errorMessage(error);
        throw error;
      }
    }

    this._isConnected = true;
  }

  /**
   * Authenticates (the `/join` flow), opens the authenticated socket, loads
   * worldData, then hands the new session cookie to its listeners. Replaces
   * the previous socket, if any.
   */
  private async establishSession(user: string, password: string): Promise<void> {
    const { session } = await authenticateFoundry(this.config.baseUrl, user, password);

    // Connect authenticated socket and load world data
    const { overflowed } = await this.connectAndLoadWorld(session);
    this.markWorldDataStale(overflowed, REPLAY_OVERFLOW_REASON);
    this.session = session;
    this.awaitingSession = false;
    this.setConnectionState('connected', null);
    logger.info('Connected to FoundryVTT via Socket.IO', {
      actors: this.worldData?.actors.length ?? 0,
      scenes: this.worldData?.scenes.length ?? 0,
      items: this.worldData?.items.length ?? 0,
    });
    this.rereadJournalsAutosavedDuringLoad();
    for (const listener of this.sessionListeners) {
      try {
        listener(session);
      } catch (error) {
        logger.warn('A session listener failed', { error: errorMessage(error) });
      }
    }
  }

  /**
   * Cookie of the current FoundryVTT session, for the headless GM page that
   * shares it; `null` before the first authentication. Never log it.
   */
  currentSession(): string | null {
    return this.session;
  }

  /**
   * Called with the new cookie after every successful authentication.
   *
   * @returns a function that removes the listener
   */
  onSessionChanged(listener: (session: string) => void): () => void {
    this.sessionListeners.add(listener);
    return () => {
      this.sessionListeners.delete(listener);
    };
  }

  /**
   * Authenticates again and replaces the socket. One attempt at a time:
   * concurrent callers share it. A failed attempt schedules the next one on
   * its own, waiting {@link REAUTH_BASE_RETRY_MS} and doubling up to
   * {@link REAUTH_MAX_RETRY_MS}, so the link comes back without any tool call.
   *
   * @param reason - why the session is no longer usable (logged)
   * @throws the error of this attempt (the retries still go on)
   */
  reauthenticate(reason: string): Promise<void> {
    if (this.reauthInFlight) {
      return this.reauthInFlight;
    }
    const user = this.config.userId || this.config.username;
    const password = this.config.password;
    if (this.stopped || !(user && password)) {
      return Promise.reject(new Error('No Socket.IO credentials to reauthenticate with'));
    }
    clearTimeout(this.reauthTimer ?? undefined);
    this.reauthTimer = null;
    this.setConnectionState('reauthenticating', reason);
    const attempt = (async () => {
      try {
        await this.establishSession(user, password);
        this.reauthDelayMs = REAUTH_BASE_RETRY_MS;
      } catch (error) {
        if (!this.stopped) {
          this.setConnectionState(
            error instanceof NoActiveWorldError ? 'waiting-for-world' : 'retrying',
            errorMessage(error),
          );
          this.scheduleReauth();
        }
        throw error;
      } finally {
        this.reauthInFlight = null;
      }
    })();
    this.reauthInFlight = attempt;
    return attempt;
  }

  /**
   * Starts the background reconnection after a failed {@link connect} (no
   * active world yet, typically). The first attempt waits the base delay.
   */
  startReconnecting(error: unknown): void {
    this.stopped = false;
    this.setConnectionState(
      error instanceof NoActiveWorldError ? 'waiting-for-world' : 'retrying',
      errorMessage(error),
    );
    this.scheduleReauth();
  }

  private scheduleReauth(): void {
    if (this.stopped) {
      return;
    }
    clearTimeout(this.reauthTimer ?? undefined);
    const delay = this.reauthDelayMs;
    this.reauthDelayMs = Math.min(this.reauthDelayMs * 2, REAUTH_MAX_RETRY_MS);
    this.reauthTimer = setTimeout(() => {
      this.reauthTimer = null;
      // A failure is already logged and rescheduled by reauthenticate().
      this.reauthenticate('retrying the connection').catch(() => undefined);
    }, delay);
  }

  /**
   * Records a state change and logs it once: a retry loop that keeps
   * failing the same way writes one line, not one per attempt.
   */
  private setConnectionState(state: ConnectionState, error: string | null): void {
    const previous = this.connectionState;
    this.connectionState = state;
    this.connectionError = state === 'connected' ? null : error;
    if (state === 'connected') {
      const summary = previous !== 'connected' ? this.takeOutageSummary() : '';
      if (previous !== 'connected' && (this.loggedConnection !== null || summary)) {
        logger.info(`FoundryVTT connection restored${summary}`);
      }
      this.loggedConnection = null;
      for (const wake of this.connectionWaiters) {
        wake();
      }
      this.connectionWaiters.clear();
      return;
    }
    // A retry passes through `reauthenticating` on every attempt; only the
    // first one after a working link is worth a line.
    if (state === 'reauthenticating' && this.loggedConnection !== null) {
      return;
    }
    const key = `${state}: ${error ?? ''}`;
    if (key !== this.loggedConnection) {
      this.loggedConnection = key;
      logger.warn(`FoundryVTT connection: ${state}${error ? ` — ${error}` : ''}`);
    }
  }

  /** State of the Socket.IO link and why it is down, if it is. */
  connectionStatus(): ConnectionStatus {
    return { state: this.connectionState, error: this.connectionError };
  }

  /**
   * True when Socket.IO credentials are configured and the link is not
   * usable right now — a tool call should wait for it rather than read a
   * cache nobody keeps live or write on an anonymous socket.
   */
  isReconnecting(): boolean {
    const hasCredentials = Boolean(
      (this.config.userId || this.config.username) && this.config.password,
    );
    return hasCredentials && !this.stopped && !this.isSocketAuthenticated();
  }

  /**
   * Waits until the link is authenticated again.
   *
   * @returns true once connected, false when `timeoutMs` ran out first
   */
  waitUntilConnected(timeoutMs: number): Promise<boolean> {
    if (this.isSocketAuthenticated()) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.connectionWaiters.delete(wake);
        resolve(false);
      }, timeoutMs);
      this.connectionWaiters.add(wake);
    });
  }

  /** The socket is up and FoundryVTT knows the user of its session. */
  private isSocketAuthenticated(): boolean {
    return this.connectionState === 'connected' && this.canSendOnSocket();
  }

  /**
   * False while the socket may be anonymous: its transport just came back
   * and FoundryVTT has not said whose session it carries yet, or the
   * session is known to be lost (a reauthentication is pending).
   */
  private canSendOnSocket(): boolean {
    return (
      this.socket?.connected === true &&
      !this.awaitingSession &&
      !SESSION_LOST_STATES.has(this.connectionState)
    );
  }

  /** Name and role of the account this client is logged in with. */
  accountInfo(): { userId: string; name: string; role: number | null } | null {
    if (!this.worldData) {
      return null;
    }
    const { userId } = this.worldData;
    const user = this.worldData.users?.find((u) => u._id === userId);
    return {
      userId,
      name: user?.name ?? userId,
      role: typeof user?.role === 'number' ? user.role : null,
    };
  }

  /**
   * The user FoundryVTT's browser clients elect as active GM: among the
   * active users with at least the Assistant GM role, the highest role, then
   * the smallest id (`game.users.activeGM`, v14
   * client/documents/collections/users.mjs `getDesignatedUser`). Computed
   * from the cache: `null` when nobody qualifies or no world is loaded.
   */
  activeGameMaster(): { userId: string; name: string; role: number } | null {
    if (!this.worldData) {
      return null;
    }
    const active = new Set(this.worldData.activeUsers);
    let designated: { userId: string; name: string; role: number } | null = null;
    for (const user of this.worldData.users ?? []) {
      if (
        !active.has(user._id) ||
        typeof user.role !== 'number' ||
        user.role < USER_ROLES.assistant
      ) {
        continue;
      }
      if (
        !designated ||
        user.role > designated.role ||
        (user.role === designated.role && user._id < designated.userId)
      ) {
        designated = { userId: user._id, name: user.name, role: user.role };
      }
    }
    return designated;
  }

  /**
   * Connects Socket.IO with an authenticated session and loads worldData
   * ({@link loadWorldSnapshot}, which installs it).
   *
   * The data listeners and the replay are set up with the socket, before
   * the handshake: a broadcast that arrives after FoundryVTT names the user
   * but before the world is asked for (even in the same packet as the
   * `session` event), or while FoundryVTT builds and sends the snapshot, is
   * kept and replayed onto it instead of being lost. The lifecycle listeners
   * (`connect`, `disconnect`, `session`, `shutdown`) come only once the
   * snapshot is in: before that, the handshake's own `session` handler
   * decides, and a `session` event must not read as connected yet.
   *
   * @returns whether the replay overflowed (the cache is then stale)
   */
  private async connectAndLoadWorld(session: string): Promise<{ overflowed: boolean }> {
    // A previous socket must not outlive its replacement (see `detachSocket`).
    this.detachSocket();
    const replay: WorldReplay = { changes: [], overflowed: false };
    this.worldReplay = replay;
    const socket = io(this.config.baseUrl, sessionSocketOptions(session));
    this.socket = socket;
    this.attachDataListeners(socket);
    const deadline = Date.now() + WORLD_LOAD_TIMEOUT_MS;
    const timeoutMessage = `Timeout waiting for world data (${WORLD_LOAD_TIMEOUT_MS / 1000}s)`;

    try {
      await this.waitForSessionUser(socket, WORLD_LOAD_TIMEOUT_MS, timeoutMessage);
      const { overflowed } = await this.loadWorldSnapshot(socket, {
        timeoutMs: Math.max(deadline - Date.now(), 0),
        timeoutMessage,
        schemaWarning: 'WorldData failed schema validation — proceeding with raw data',
        replay,
      });
      // Liveness (laurigates/foundryvtt-mcp#217): a socket that drops on its own must stop reading
      // as connected, and one that socket.io reconnects must read as
      // connected again. Both are removed in `disconnect()`.
      socket.on('connect', this.onSocketConnect);
      socket.on('disconnect', this.onSocketDisconnect);
      // Authentication (01.11 zombie socket): FoundryVTT answers every
      // (re)connection with `session`; one without a user means the
      // server forgot the session (restart) or no world is running.
      socket.on('session', this.onSessionEvent);
      // The world was shut down: its sessions outlive it, its sockets
      // do not (a socket is only bound to a user when it connects).
      socket.on('shutdown', this.onWorldShutdown);
      // Each failed reconnection attempt while the socket is down.
      socket.on('connect_error', this.onReconnectError);
      return { overflowed };
    } catch (error) {
      if (this.worldReplay === replay) {
        this.worldReplay = null;
      }
      this.detachDataListeners(socket);
      socket.disconnect();
      throw error;
    }
  }

  /**
   * Keeps the cache live from the moment the socket exists
   * (laurigates/foundryvtt-mcp#205); see {@link changeCache} for the
   * changes that arrive while a snapshot loads.
   */
  private attachDataListeners(socket: Socket): void {
    socket.on('modifyDocument', this.onDocumentBroadcast);
    // Batches and operations with server-side side effects arrive here
    // instead, never on both channels.
    socket.on('modifyDocumentBatch', this.onDocumentBatchBroadcast);
    // Presence (laurigates/foundryvtt-mcp#218): `activeUsers` is not a document collection, so it
    // only moves on this event.
    socket.on('userActivity', this.onUserActivity);
    // Collaborative-editor autosaves bypass `modifyDocument` entirely.
    socket.on('pm.autosave', this.onEditorAutosave);
  }

  private detachDataListeners(socket: Socket): void {
    socket.off('modifyDocument', this.onDocumentBroadcast);
    socket.off('modifyDocumentBatch', this.onDocumentBatchBroadcast);
    socket.off('userActivity', this.onUserActivity);
    socket.off('pm.autosave', this.onEditorAutosave);
  }

  /** The handshake: FoundryVTT's first `session` event must name a user. */
  private waitForSessionUser(
    socket: Socket,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        socket.off('session', onSession);
        socket.off('connect_error', onConnectError);
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(timeoutMessage));
      }, timeoutMs);
      const onSession = (data: { userId?: string } | null) => {
        cleanup();
        if (!data?.userId) {
          reject(new Error('Authentication failed — session event returned no userId'));
          return;
        }
        resolve();
      };
      const onConnectError = (err: Error) => {
        cleanup();
        reject(new Error(`Socket.IO connection failed: ${describeConnectError(err)}`));
      };
      socket.on('session', onSession);
      socket.on('connect_error', onConnectError);
    });
  }

  /**
   * Applies a FoundryVTT `modifyDocument` broadcast to the cached world state (laurigates/foundryvtt-mcp#205).
   *
   * Bound field rather than a method so the same reference can be passed to
   * `socket.off()` on teardown. Never throws: a malformed or unmodelled payload
   * leaves the cache untouched (and stale) rather than taking the connection down.
   */
  private onDocumentBroadcast = (payload: unknown): void => {
    if (!this.hasCacheTarget()) {
      return;
    }
    const broadcast = parseDocumentBroadcast(payload);
    if (broadcast) {
      this.handleDocumentBroadcast(broadcast);
    }
  };

  /**
   * Applies a FoundryVTT v14 `modifyDocumentBatch` broadcast: each element
   * goes through the same path as a `modifyDocument` broadcast, in order.
   * Sent for `foundry.documents.modifyBatch()` and for any single operation
   * with server-side side effects (see `parseDocumentBatch`).
   *
   * Bound field rather than a method so the same reference reaches `socket.off()`.
   */
  private onDocumentBatchBroadcast = (payload: unknown): void => {
    if (!this.hasCacheTarget()) {
      return;
    }
    for (const broadcast of parseDocumentBatch(payload) ?? []) {
      this.handleDocumentBroadcast(broadcast);
    }
  };

  /** Cache, event log and journal overwrite watch for one document broadcast. Never throws. */
  private handleDocumentBroadcast(broadcast: DocumentBroadcast): void {
    if (!this.hasCacheTarget()) {
      return;
    }

    try {
      const applied = this.changeCache((worldData) => applyDocumentBroadcast(worldData, broadcast));
      logger.debug(
        !this.worldData
          ? `Kept ${broadcast.action} ${broadcast.type} broadcast for the world data being loaded`
          : applied
            ? `Applied ${broadcast.action} ${broadcast.type} broadcast to cached worldData`
            : `Ignored ${broadcast.action} ${broadcast.type} broadcast (not cached)`,
      );
    } catch (error) {
      logger.warn('Failed to apply document broadcast to cached worldData', {
        type: broadcast.type,
        action: broadcast.action,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (!this.worldData) {
      // First load of the session: the event log and the overwrite watch
      // start with the snapshot.
      return;
    }

    // Recorded regardless of cache outcome — an uncached type (e.g. Setting)
    // is still world activity a `watch_events` caller may be waiting on.
    // Isolated in its own try/catch: a summarizer bug must never take the
    // socket connection down.
    try {
      this.eventLog.append(summarizeDocumentBroadcast(broadcast, this.worldData));
    } catch (error) {
      logger.warn('Failed to record document broadcast to the event log', {
        type: broadcast.type,
        action: broadcast.action,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (broadcast.type === 'JournalEntryPage' && broadcast.action === 'update') {
      const journalId = /^JournalEntry\.([a-zA-Z0-9]{16})$/.exec(broadcast.parentUuid ?? '')?.[1];
      const userId = broadcast.userId;
      if (journalId && userId && !this.connectorUserIds().has(userId)) {
        for (const doc of broadcast.result) {
          if (!isRecord(doc) || typeof doc._id !== 'string') {
            continue;
          }
          const text = isRecord(doc.text) ? doc.text : undefined;
          this.observeJournalChange({
            journalId,
            pageId: doc._id,
            content: typeof text?.content === 'string' ? text.content : undefined,
            source: { kind: 'user', userId },
          });
        }
      }
    }
  }

  /**
   * Handles a collaborative-editor autosave (`pm.autosave`).
   *
   * While a text page is open in an editor, the FoundryVTT v14 server keeps
   * its own copy of the page and saves it every `core.editorAutosaveSecs`,
   * straight to the database: no `modifyDocument` broadcast, no author. This
   * event, sent to every user, is the only trace. It feeds the overwrite
   * watch, then the entry is re-read so the cache picks up the change.
   *
   * Bound field rather than a method so the same reference reaches `socket.off()`.
   */
  private onEditorAutosave = (uuid: unknown, html: unknown): void => {
    if (typeof uuid !== 'string' || typeof html !== 'string') {
      return;
    }
    const match =
      /^JournalEntry\.([a-zA-Z0-9]{16})\.JournalEntryPage\.([a-zA-Z0-9]{16})#text\.content$/.exec(
        uuid,
      );
    if (!match?.[1] || !match[2]) {
      return;
    }
    const journalId = match[1];
    this.observeJournalChange({
      journalId,
      pageId: match[2],
      content: html,
      source: { kind: 'autosave' },
    });
    if (!this.canSendOnSocket()) {
      // A reauthentication is loading the world on a new socket, or the
      // session is not known yet: nothing may be asked now. Re-read once it
      // can. (On a first load the request may go: its answer goes through
      // changeCache, so it reaches the snapshot being loaded.)
      this.autosavedDuringLoad.add(journalId);
      return;
    }
    this.rereadAutosavedJournal(journalId);
  };

  private rereadAutosavedJournal(journalId: string): void {
    this.fetchJournalEntry(journalId).catch((error: unknown) => {
      logger.warn('Could not re-read a journal entry after an editor autosave', {
        journalId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /** Re-reads the entries autosaved while the socket could not be asked. */
  private rereadJournalsAutosavedDuringLoad(): void {
    const journalIds = [...this.autosavedDuringLoad];
    this.autosavedDuringLoad.clear();
    for (const journalId of journalIds) {
      this.rereadAutosavedJournal(journalId);
    }
  }

  /** The connected user plus the connector's other sessions (headless GM). */
  private connectorUserIds(): Set<string> {
    const ids = new Set<string>();
    if (this.worldData?.userId) {
      ids.add(this.worldData.userId);
    }
    const names = new Set(this.config.connectorUsernames ?? []);
    for (const user of this.worldData?.users ?? []) {
      if (names.has(user.name)) {
        ids.add(user._id);
      }
    }
    return ids;
  }

  /** Name of the account this client is logged in with. */
  private connectorAccountName(): string {
    return this.worldData ? this.userName(this.worldData.userId) : 'connector';
  }

  private userName(userId: string): string {
    return this.worldData?.users?.find((user) => user._id === userId)?.name ?? userId;
  }

  /** Feeds a foreign page change to the watch and reports an overwrite it reveals. */
  private observeJournalChange(change: ForeignChange): void {
    const seen = this.journalWatch.observe(change);
    if (seen.kind !== 'lost') {
      return;
    }
    const { watched } = seen;
    const savedBy = change.source.kind === 'autosave' ? null : this.userName(change.source.userId);
    this.reportJournalConflict({
      journalId: watched.journalId,
      pageId: watched.pageId,
      journalName: watched.journalName,
      pageName: watched.pageName,
      reason: savedBy ? `overwritten-by-${savedBy}` : 'overwritten-by-editor-autosave',
      savedBy,
      // The version that was lost is the connector's.
      copy: watched.after,
      overwrittenBy: savedBy ?? EDITOR_AUTOSAVE_USER,
      versionBy: this.connectorAccountName(),
      detail: `${seen.lost.length} paragraph(s) the connector had written are gone`,
    });
  }

  /**
   * Records a detected overwrite: local copy of the lost version, a warn-level
   * log line (ids and path only — never content), a pending warning for the
   * next journal tool, the 24-hour list, and the GM whisper hook.
   */
  private reportJournalConflict(params: {
    journalId: string;
    pageId: string;
    journalName: string;
    pageName: string;
    reason: string;
    savedBy: string | null;
    copy: string;
    overwrittenBy: string;
    versionBy: string;
    detail: string;
  }): void {
    let historyPath: string | null = null;
    try {
      historyPath = this.journalHistory.save({
        journalId: params.journalId,
        pageId: params.pageId,
        journalName: params.journalName,
        pageName: params.pageName,
        reason: params.reason,
        content: params.copy,
        overwrittenBy: params.overwrittenBy,
        versionBy: params.versionBy,
        connectorAccount: this.connectorAccountName(),
      });
    } catch (error) {
      logger.warn('Could not save a local copy of an overwritten journal page', {
        journalId: params.journalId,
        pageId: params.pageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    logger.warn('Journal page overwrite detected', {
      journalId: params.journalId,
      pageId: params.pageId,
      reason: params.reason,
      version: journalVersion(params.copy),
      historyPath,
    });

    const conflict: JournalConflict = {
      at: Date.now(),
      journalId: params.journalId,
      pageId: params.pageId,
      journalName: params.journalName,
      pageName: params.pageName,
      reason: params.reason,
      savedBy: params.savedBy,
      historyPath,
    };
    this.journalWatch.recordConflict(conflict);
    this.journalWatch.addWarning(
      `⚠️ **Journal overwrite detected:** page "${params.pageName}" of "${params.journalName}" ` +
        `(${params.journalId}/${params.pageId}) — saved by ${conflictAuthor(conflict)}; ${params.detail}. ` +
        (historyPath
          ? `The overwritten version is saved at ${historyPath}.`
          : 'No local copy could be written.'),
    );
    try {
      this.onJournalConflict?.(conflict);
    } catch (error) {
      logger.warn('Journal conflict notification failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Returns and clears the warnings waiting for the next journal tool response. */
  drainJournalWarnings(): string[] {
    return this.journalWatch.drainWarnings();
  }

  /** Journal overwrites detected in the last 24 hours, oldest first. */
  getRecentJournalConflicts(): JournalConflict[] {
    return this.journalWatch.recentConflicts();
  }

  /** Folder holding the local copies of journal pages. */
  getJournalHistoryDir(): string {
    return this.journalHistory.root;
  }

  /**
   * Applies a FoundryVTT `userActivity` broadcast to cached presence (laurigates/foundryvtt-mcp#218).
   *
   * Foundry emits this on login, on logout, and on ordinary activity, and it is
   * the only signal that moves `worldData.activeUsers` — that field is a
   * top-level `WorldData` entry, not a document collection, so the
   * `modifyDocument` path never touches it and `get_users` would otherwise
   * answer "who is connected?" from the connect-time snapshot forever.
   *
   * Bound field rather than a method so the same reference reaches `socket.off()`.
   * Never throws: an unrecognized payload leaves presence as it was.
   */
  private onUserActivity = (userId: unknown, activityData?: unknown): void => {
    if (!this.hasCacheTarget()) {
      return;
    }

    const activity = parseUserActivity(userId, activityData);
    if (!activity) {
      logger.debug('Ignored unrecognized userActivity payload');
      return;
    }

    if (this.changeCache((worldData) => applyUserActivity(worldData, activity))) {
      logger.debug(
        `User ${activity.userId} is now ${activity.active ? 'active' : 'inactive'} (userActivity)`,
      );
      const name = this.worldData?.users?.find((user) => user._id === activity.userId)?.name;
      this.eventLog.append({
        kind: 'presence',
        type: '',
        action: activity.active ? 'active' : 'inactive',
        userId: activity.userId,
        ids: [activity.userId],
        summary: `👤 ${name ?? activity.userId} ${activity.active ? 'connected' : 'disconnected'}`,
      });
    }
  };

  /**
   * Reacts to the socket dropping on its own — server restart, network loss,
   * an idle timeout (laurigates/foundryvtt-mcp#217).
   *
   * Moves the link to `disconnected` so `isConnected()` and `get_health_status` stop
   * claiming a live link, and marks the cached snapshot stale: nothing is
   * applying `modifyDocument` broadcasts while the socket is down, so whatever
   * is in `worldData` from here on is a point-in-time copy, not live state.
   * The cache is deliberately *kept* rather than dropped — a stale answer with
   * an honest connection line beats no answer at all — and Socket.IO's own
   * reconnect logic may bring the link back, at which point `refreshWorldData()`
   * resyncs it.
   *
   * Bound field rather than a method so the same reference reaches `socket.off()`.
   */
  /**
   * Reacts to socket.io bringing the link back up on its own (laurigates/foundryvtt-mcp#217).
   *
   * `sessionSocketOptions` leaves socket.io-client's default
   * `reconnection: true` in place, so after a transient drop the manager
   * re-handshakes the SAME socket instance (the session cookie rides along in
   * `extraHeaders`) and the persistent `modifyDocument`/`userActivity`
   * listeners resume firing. The link reads as connected again only once
   * FoundryVTT's `session` event names a user ({@link onSessionEvent}): after
   * a server restart the same reconnect yields an anonymous socket.
   *
   * `worldDataStale` is *not* cleared here: broadcasts emitted while the
   * socket was down were never delivered and are not replayed. Once
   * FoundryVTT names the user, {@link onSessionEvent} reloads the world.
   *
   * Bound field rather than a method so the same reference reaches `socket.off()`.
   */
  private onSocketConnect = (): void => {
    // Only the transport is back: FoundryVTT may not know the session any
    // more (a server restart forgets every session). `onSessionEvent` decides.
    this.awaitingSession = true;
    logger.debug('FoundryVTT socket transport reconnected — waiting for its session');
  };

  /**
   * Handles the `session` event FoundryVTT sends on every (re)connection of
   * the socket. With a user, the reconnected socket is authenticated again,
   * and a cache that went stale while it was down is reloaded in the
   * background; without one (server restarted, world not running), it is
   * anonymous and the client authenticates anew.
   *
   * Bound field rather than a method so the same reference reaches `socket.off()`.
   */
  private onSessionEvent = (data: unknown): void => {
    this.awaitingSession = false;
    if (this.reauthInFlight) {
      return;
    }
    const userId = isRecord(data) && typeof data.userId === 'string' ? data.userId : null;
    if (userId) {
      if (this.connectionState !== 'connected') {
        this.setConnectionState('connected', null);
        logger.info('FoundryVTT socket reconnected with the same session');
      }
      if (this.worldDataStale) {
        this.reloadAfterReconnection();
      }
      this.rereadJournalsAutosavedDuringLoad();
      return;
    }
    this.reauthenticate('FoundryVTT no longer recognises the session (server restart?)').catch(
      () => undefined,
    );
  };

  /** Bound field rather than a method so the same reference reaches `socket.off()`. */
  private onWorldShutdown = (): void => {
    this.markWorldDataStale(this.worldData !== null, 'the world was shut down');
    this.reauthenticate('the world was shut down').catch(() => undefined);
  };

  /**
   * Reloads the world without blocking anyone (tools keep answering from the
   * stale cache meanwhile). A failure leaves the cache stale.
   */
  private reloadAfterReconnection(): void {
    logger.info('Reloading the world data after the socket reconnected');
    this.refreshWorldData().catch((error: unknown) => {
      logger.warn(
        'Could not reload the world data after the socket reconnected — the cache stays stale',
        { error: errorMessage(error) },
      );
      if (this.worldDataStale) {
        this.markWorldDataStale(
          true,
          `the reload after the reconnection failed: ${errorMessage(error)}`,
        );
      }
    });
  }

  private onSocketDisconnect = (reason?: unknown): void => {
    this.socketDrops += 1;
    this.outage ??= { since: Date.now(), failedAttempts: 0, loggedAt: 0, loggedMessage: null };
    // Socket.IO never answers a request sent before the drop.
    this.cancelWorldReload?.('the socket dropped while the world data was loading');
    this.markWorldDataStale(this.worldData !== null, 'the socket dropped');
    if (this.reauthInFlight || this.connectionState !== 'connected') {
      return;
    }
    this.setConnectionState('disconnected', 'the socket dropped');
    logger.warn('FoundryVTT socket disconnected — cached world data is now stale', {
      reason: typeof reason === 'string' ? reason : undefined,
    });
  };

  /**
   * A reconnection attempt of socket.io failed (socket.io emits
   * `connect_error` for each one while the socket is down). The first
   * failure is logged, then one line per {@link RECONNECT_ERROR_LOG_INTERVAL_MS},
   * or at once when the error changes; the count goes into the line written
   * when the connection is back ({@link takeOutageSummary}).
   *
   * Bound field rather than a method so the same reference reaches `socket.off()`.
   */
  private onReconnectError = (error: unknown): void => {
    this.outage ??= { since: Date.now(), failedAttempts: 0, loggedAt: 0, loggedMessage: null };
    const outage = this.outage;
    outage.failedAttempts += 1;
    const message = describeConnectError(error);
    const now = Date.now();
    if (
      outage.loggedMessage === null ||
      message !== outage.loggedMessage ||
      now - outage.loggedAt >= RECONNECT_ERROR_LOG_INTERVAL_MS
    ) {
      outage.loggedAt = now;
      outage.loggedMessage = message;
      logger.warn(
        `FoundryVTT socket reconnection failed (attempt ${outage.failedAttempts}): ${message}`,
      );
    }
  };

  /**
   * Ends the outage record: e.g. " after 42 s and 9 failed reconnection
   * attempt(s)", or `''` when there was none.
   */
  private takeOutageSummary(): string {
    const outage = this.outage;
    if (!outage) {
      return '';
    }
    this.outage = null;
    const seconds = Math.round((Date.now() - outage.since) / 1000);
    return ` after ${seconds} s and ${outage.failedAttempts} failed reconnection attempt(s)`;
  }

  /**
   * Closes the current socket and removes every persistent listener bound to
   * it. Used both by `disconnect()` and before a socket is replaced: a
   * superseded socket that kept its `disconnect` handler would otherwise clear
   * the connected flag of the live socket that replaced it when it finally
   * closed (`DiagnosticsClient.testAuthentication()` re-connects a live
   * client, so this is reachable in-repo).
   */
  private detachSocket(): void {
    this.cancelWorldReload?.('the connection closed while the world data was loading');
    if (!this.socket) {
      return;
    }
    this.detachDataListeners(this.socket);
    this.socket.off('connect', this.onSocketConnect);
    this.socket.off('disconnect', this.onSocketDisconnect);
    this.socket.off('session', this.onSessionEvent);
    this.socket.off('shutdown', this.onWorldShutdown);
    this.socket.off('connect_error', this.onReconnectError);
    this.socket.disconnect();
    this.socket = null;
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reauthTimer ?? undefined);
    this.reauthTimer = null;
    this.detachSocket();
    this.worldData = null;
    this.markWorldDataStale(false);
    this._isConnected = false;
    this.session = null;
    this.connectionState = 'disconnected';
    this.connectionError = null;
    this.loggedConnection = null;
    this.awaitingSession = false;
    this.restLinkLive = true;
    this.outage = null;
    logger.info('FoundryVTT client disconnected');
  }

  /** True when `FOUNDRY_API_KEY` is set: the REST API module backs diagnostics. */
  hasRestApi(): boolean {
    return Boolean(this.config.apiKey);
  }

  /**
   * Reports whether the client currently has a live link to FoundryVTT (laurigates/foundryvtt-mcp#217).
   *
   * Socket.IO mode answers from the socket itself rather than from a latched
   * flag, so a link that dropped without an explicit `disconnect()` — server
   * restart, network loss — reads as disconnected immediately, even if the
   * `disconnect` event has not been delivered yet. It tracks the socket in both
   * directions: an automatic reconnect (`onSocketConnect`) reads as connected
   * again rather than staying latched off.
   *
   * REST API mode (`FOUNDRY_API_KEY`) has no socket to ask, so it answers from
   * the last REST request that actually happened: a request that failed to
   * reach FoundryVTT (connection refused, reset, timed out) reads as
   * disconnected from then on, and the next request that gets through reads as
   * connected again. An HTTP error status does not count as a drop — the
   * server answered. This is a *last observed outcome*, not a live probe: it
   * cannot notice a server that went away between requests, and it never does
   * I/O of its own, because this accessor is synchronous and widely called.
   */
  isConnected(): boolean {
    // A socket, once established, is the more informative signal (reacts to
    // drops/reconnects immediately — see laurigates/foundryvtt-mcp#217) — prefer it even when an
    // apiKey is also configured (REST is additive; see `connect()`).
    // A connected but anonymous socket (FoundryVTT forgot the session) does
    // not count: nothing it sends is executed as the connector's user.
    if (this.socket) {
      return this.isSocketAuthenticated();
    }
    if (this.config.apiKey) {
      return this._isConnected && this.restLinkLive;
    }
    return false;
  }

  /**
   * True when the cached snapshot is no longer being kept live by broadcasts —
   * i.e. the socket dropped after a world load (laurigates/foundryvtt-mcp#217). Reads still answer from
   * the cache; this flags that the answer is a point-in-time copy.
   */
  isWorldDataStale(): boolean {
    return this.worldDataStale;
  }

  /** Since when and why the cache is stale, for `status`; `null` while it is live. */
  worldDataStaleness(): { since: string | null; reason: string | null } | null {
    if (!this.worldDataStale) {
      return null;
    }
    return {
      since: this.worldDataStaleSince?.toISOString() ?? null,
      reason: this.worldDataStaleReason,
    };
  }

  /**
   * Marks the cache stale, or live again. A cache that stays stale keeps the
   * time it became so; its reason is the latest one.
   */
  private markWorldDataStale(stale: boolean, reason?: string): void {
    if (!stale) {
      this.worldDataStale = false;
      this.worldDataStaleSince = null;
      this.worldDataStaleReason = null;
      return;
    }
    if (!this.worldDataStale || this.worldDataStaleSince === null) {
      this.worldDataStaleSince = new Date();
    }
    this.worldDataStale = true;
    this.worldDataStaleReason = reason ?? this.worldDataStaleReason;
  }

  /**
   * Whether `FOUNDRY_WRITE_ENABLED` is set, without attempting a write.
   * Lets a caller that batches several writes in one tool call (e.g.
   * `move_tokens`) fail fast with one clear error instead of repeating
   * {@link assertWriteable}'s message once per item.
   */
  isWriteEnabled(): boolean {
    return this.config.writeEnabled === true;
  }

  /**
   * Returns true if worldData is available (Socket.IO mode connected).
   */
  hasWorldData(): boolean {
    return this.worldData !== null;
  }

  /**
   * Records a bridge-pushed browser event (targeting, pings, …) into the
   * world-event log, so `watch_events` sees canvas-only activity that never
   * crosses the `modifyDocument` socket channel.
   *
   * An unrecognized `type` is dropped rather than thrown: a newer companion
   * module pushing an event this server version does not model must never
   * crash the connection.
   */
  recordModuleEvent(type: string, payload: Record<string, unknown>): void {
    if (type === 'target_token') {
      const tokenId = typeof payload.tokenId === 'string' ? payload.tokenId : undefined;
      const userId = typeof payload.userId === 'string' ? payload.userId : undefined;
      const userName = typeof payload.userName === 'string' ? payload.userName : undefined;
      const tokenName = typeof payload.tokenName === 'string' ? payload.tokenName : undefined;
      const sceneId = typeof payload.sceneId === 'string' ? payload.sceneId : undefined;
      const targeted = payload.targeted === true;
      this.eventLog.append({
        kind: 'target',
        type: '',
        action: targeted ? 'target' : 'untarget',
        ...(userId ? { userId } : {}),
        ...(sceneId ? { sceneId } : {}),
        ids: tokenId ? [tokenId] : [],
        summary: `🎯 ${userName ?? userId ?? 'Someone'} ${targeted ? 'targeted' : 'un-targeted'} ${tokenName ?? tokenId ?? 'a token'}`,
      });
      return;
    }
    logger.debug(`Ignored unrecognized module-pushed event: ${type}`);
  }

  /**
   * Reads world activity recorded since `cursor`, blocking up to `waitMs`
   * when nothing has happened yet.
   *
   * A read-only entry point — no `assertWriteable()` — and the only way a
   * handler reaches `eventLog`; the log itself stays private.
   */
  async watchEvents(params: {
    cursor?: string;
    waitMs?: number;
    limit?: number;
    kinds?: string[];
    types?: string[];
    actions?: string[];
    sceneId?: string;
    excludeSelf?: boolean;
  }): Promise<EventReadResult & { cursorResolvedFrom: 'now' | 'oldest' | 'explicit' }> {
    let from: number;
    let cursorResolvedFrom: 'now' | 'oldest' | 'explicit';
    const cursor = params.cursor ?? 'now';
    if (cursor === 'now') {
      from = this.eventLog.head();
      cursorResolvedFrom = 'now';
    } else if (cursor === 'oldest') {
      from = Math.max(0, this.eventLog.oldest() - 1);
      cursorResolvedFrom = 'oldest';
    } else if (/^\d+$/.test(cursor)) {
      from = Number.parseInt(cursor, 10);
      cursorResolvedFrom = 'explicit';
    } else {
      throw new Error(`Invalid cursor: ${cursor}`);
    }

    const excludeUserId =
      params.excludeSelf !== false && this.worldData ? this.worldData.userId : undefined;
    const filter: EventFilter = {
      ...(params.kinds ? { kinds: params.kinds } : {}),
      ...(params.types ? { types: params.types } : {}),
      ...(params.actions ? { actions: params.actions } : {}),
      ...(params.sceneId ? { sceneId: params.sceneId } : {}),
      ...(excludeUserId ? { excludeUserId } : {}),
    };
    const limit = params.limit ?? 50;

    let result = this.eventLog.read(from, filter, limit);
    if (result.events.length === 0 && (params.waitMs ?? 0) > 0) {
      await this.eventLog.wait(from, params.waitMs ?? 0);
      result = this.eventLog.read(from, filter, limit);
    }
    return { ...result, cursorResolvedFrom };
  }

  // ==========================================================================
  // World data accessors
  // ==========================================================================

  /**
   * Re-emits 'world' on the existing socket to refresh the cached snapshot.
   *
   * FoundryVTT answers the `world` request through the Socket.IO
   * acknowledgement callback, exactly as in {@link connectAndLoadWorld}; it
   * never sends a separate `world` event, so listening for one always timed
   * out. An ack that arrives after the timeout is ignored.
   *
   * One reload at a time: concurrent callers (`refresh_world_data`, the
   * journal read fallback, the reload after a reconnection) share it. Cache
   * changes made while it runs are replayed onto the new snapshot, which the
   * server may have built before them ({@link changeCache}). The cache stays
   * stale when that replay overflowed or the socket dropped meanwhile. A
   * drop, a replaced socket or `disconnect()` cancels the reload.
   */
  refreshWorldData(): Promise<void> {
    if (this.worldReload) {
      return this.worldReload;
    }
    const reload = this.reloadWorldData().finally(() => {
      this.worldReload = null;
    });
    this.worldReload = reload;
    return reload;
  }

  private async reloadWorldData(): Promise<void> {
    const socket = this.socket;
    if (!socket?.connected) {
      throw new Error('Not connected — cannot refresh world data');
    }
    this.assertAuthenticated();
    const drops = this.socketDrops;
    const { data, overflowed } = await this.loadWorldSnapshot(socket, {
      timeoutMs: WORLD_LOAD_TIMEOUT_MS,
      timeoutMessage: 'Refresh timeout',
      schemaWarning: 'WorldData refresh failed schema validation — proceeding with raw data',
    });
    if (overflowed) {
      this.markWorldDataStale(true, REPLAY_OVERFLOW_REASON);
    } else {
      this.markWorldDataStale(
        this.socketDrops !== drops,
        'the socket dropped while the world data was reloading',
      );
    }
    logger.info('World data refreshed', {
      actors: data.actors.length,
      items: data.items.length,
    });
  }

  /**
   * Asks FoundryVTT for the whole world on `socket`, replays onto it the
   * cache changes that arrived meanwhile ({@link changeCache}), and installs
   * it as the cache. Shared by the first load of a session and the reloads.
   * An answer after the timeout, a cancellation ({@link cancelWorldReload})
   * or a replaced socket is ignored.
   *
   * @returns the installed snapshot, and whether the replay overflowed
   */
  private async loadWorldSnapshot(
    socket: Socket,
    options: {
      timeoutMs: number;
      timeoutMessage: string;
      schemaWarning: string;
      /** A replay already collecting changes (the first load opens it with the socket). */
      replay?: WorldReplay;
    },
  ): Promise<{ data: WorldData; overflowed: boolean }> {
    const replay: WorldReplay = options.replay ?? { changes: [], overflowed: false };
    this.worldReplay = replay;
    try {
      const data = await new Promise<WorldData>((resolve, reject) => {
        let settled = false;
        const settle = () => {
          settled = true;
          clearTimeout(timeoutId);
          this.cancelWorldReload = null;
        };
        const timeoutId = setTimeout(() => {
          settle();
          reject(new Error(options.timeoutMessage));
        }, options.timeoutMs);
        this.cancelWorldReload = (reason) => {
          settle();
          reject(new Error(`World data refresh cancelled: ${reason}`));
        };

        socket.emit('world', (payload: WorldData) => {
          if (settled) {
            return;
          }
          settle();
          const parsed = WorldDataSchema.safeParse(payload);
          if (!parsed.success) {
            logger.warn(options.schemaWarning, {
              issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
            });
          }
          resolve(payload);
        });
      });

      if (this.socket !== socket) {
        throw new Error('World data refresh cancelled: the connection was replaced');
      }
      for (const change of replay.changes) {
        try {
          change(data);
        } catch (error) {
          logger.warn('Failed to replay a cache change onto the reloaded world data', {
            error: errorMessage(error),
          });
        }
      }
      this.worldData = data;
      if (replay.overflowed) {
        logger.warn(
          `More than ${WORLD_REPLAY_MAX_CHANGES} cache changes arrived while the world data was loading, too many to replay — the cache stays stale until the next refresh`,
        );
      } else if (replay.changes.length > 0) {
        logger.debug(
          `Replayed ${replay.changes.length} cache change(s) onto the loaded world data`,
        );
      }
      return { data, overflowed: replay.overflowed };
    } finally {
      if (this.worldReplay === replay) {
        this.worldReplay = null;
      }
    }
  }

  /**
   * Applies a change to the cached world. While a snapshot loads (the first
   * one of a session, or a reload), the change is also kept for it: changes
   * are idempotent upserts and removals applied in arrival order, so
   * replaying one the snapshot already holds is harmless. Before the first
   * snapshot there is no cache: the change is only kept. Past
   * {@link WORLD_REPLAY_MAX_CHANGES} the kept changes are dropped and the
   * load leaves the cache stale.
   *
   * @returns what `change` returned, or `undefined` without a cache
   */
  private changeCache<T>(change: (worldData: WorldData) => T): T | undefined {
    const result = this.worldData ? change(this.worldData) : undefined;
    const replay = this.worldReplay;
    if (replay && !replay.overflowed) {
      if (replay.changes.length >= WORLD_REPLAY_MAX_CHANGES) {
        replay.changes = [];
        replay.overflowed = true;
      } else {
        replay.changes.push(change);
      }
    }
    return result;
  }

  /** True while there is a cache, or a snapshot loading that a change must reach. */
  private hasCacheTarget(): boolean {
    return this.worldData !== null || this.worldReplay !== null;
  }

  getWorldData(): WorldData | null {
    return this.worldData;
  }

  /**
   * The version of a module installed in the world, from the cached world's
   * module list; `null` when the module or its version is not there.
   */
  installedModuleVersion(moduleId: string): string | null {
    const modules = this.worldData?.modules;
    const entry = Array.isArray(modules) ? modules.find((m) => m.id === moduleId) : undefined;
    return typeof entry?.version === 'string' ? entry.version : null;
  }

  // ==========================================================================
  // Actor methods
  // ==========================================================================

  async searchActors(params: SearchActorsParams): Promise<ActorSearchResult> {
    if (this.config.apiKey) {
      return this.executeWithRetry(async () => {
        const response = await this.http.get('/api/actors', { params });
        return response.data;
      });
    }

    if (!this.worldData) {
      return { actors: [], total: 0, page: 1, limit: params.limit || 10, nextCursor: null };
    }

    let results = this.worldData.actors;

    if (params.query) {
      const q = params.query.toLowerCase();
      results = results.filter((a) => a.name.toLowerCase().includes(q));
    }
    if (params.type) {
      const t = params.type.toLowerCase();
      results = results.filter((a) => a.type.toLowerCase() === t);
    }

    const total = results.length;
    const limit = params.limit || 10;
    const offset = decodeCursor(params.cursor);
    const actors: FoundryActor[] = results.slice(offset, offset + limit).map(worldActorToFoundry);
    const nextOffset = offset + actors.length;
    const nextCursor = nextOffset < total ? encodeCursor(nextOffset) : null;

    return { actors, total, page: Math.floor(offset / limit) + 1, limit, nextCursor };
  }

  async getActor(actorId: string): Promise<FoundryActor> {
    if (!FOUNDRY_ID_PATTERN.test(actorId)) {
      throw new Error(`Invalid actorId format: ${actorId}`);
    }
    if (this.config.apiKey) {
      return this.executeWithRetry(async () => {
        const response = await this.http.get(`/api/actors/${actorId}`);
        return response.data;
      });
    }

    if (!this.worldData) {
      throw new Error('Not connected — no world data available');
    }

    const actor = this.worldData.actors.find((a) => a._id === actorId);
    if (!actor) {
      throw new Error(`Actor not found: ${actorId}`);
    }

    return worldActorToFoundry(actor);
  }

  /**
   * Returns the raw WorldActor with the full system data (game-system specific).
   */
  getRawActor(actorId: string): WorldActor | undefined {
    return this.worldData?.actors.find((a) => a._id === actorId);
  }

  /**
   * Returns an actor's owned items (equipment, spells, features) from the
   * cached worldData, with the full `system` payload of each.
   *
   * @param actorId - 16-char alphanumeric actor document id
   * @returns the actor's embedded item documents (empty array if it owns none)
   * @throws if the actor is not found in the cached world data
   */
  getActorItems(actorId: string): WorldItem[] {
    if (!FOUNDRY_ID_PATTERN.test(actorId)) {
      throw new Error(`Invalid actorId format: ${actorId}`);
    }
    const actor = this.worldData?.actors.find((a) => a._id === actorId);
    if (!actor) {
      throw new Error(`Actor not found: ${actorId}`);
    }
    return actor.items ?? [];
  }

  /**
   * Patches attributes on an actor's `system` object (laurigates/foundryvtt-mcp#143). WRITE — Socket.IO.
   *
   * `patch` keys are dot-paths into `actor.system` (e.g. `attributes.hp.value`,
   * `currency.gp`, `spells.spell1.value`, `attributes.exhaustion`). Each key is
   * prefixed with `system.` and sent through the Socket.IO `modifyDocument`
   * write protocol as an `Actor` `update` — matching FoundryVTT's own document
   * model (`Actor#update`). No REST call and no `apiKey` are involved.
   *
   * Client-side validation, using the actor's current data, rejects:
   *  - HP value exceeding `max + temp`,
   *  - spell-slot value exceeding its `max`,
   *  - exhaustion outside `0–10` (2024 rules) or `0–6` (2014 rules).
   *
   * @throws via `assertWriteable()` if `writeEnabled` is false or the socket
   *   is not connected; also if the id is malformed, the actor/path is missing,
   *   or a validation rule is violated.
   */
  async updateActorAttribute(
    actorId: string,
    patch: AttributePatch,
  ): Promise<ActorAttributeUpdateResult> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(actorId)) {
      throw new Error(`Invalid actorId format: ${actorId}`);
    }
    if (!isRecord(patch) || Object.keys(patch).length === 0) {
      throw new Error('patch is required and must contain at least one attribute path');
    }

    // Fetch current actor data to validate paths and bounds. getActor returns
    // the mapped actor in socket mode (no `system`), so fall back to the cached
    // raw actor for the system document the validator needs.
    const actor = await this.getActor(actorId);
    const rawSystem = systemOf(actor) ?? systemOf(this.getRawActor(actorId));
    validateAttributePatch(patch, actor, rawSystem);

    // The patch keys are dot-paths into `actor.system`; prefix each with
    // `system.` for the document update. FoundryVTT accepts dot-notation keys
    // in update objects and merges recursively.
    const update: Record<string, unknown> = { _id: actorId };
    for (const [path, value] of Object.entries(patch)) {
      update[`system.${path}`] = value;
    }
    const result = await this.modifyDocument('Actor', 'update', {
      updates: [update],
      diff: true,
      recursive: true,
    });

    // Echo the post-update value for each patched path. Prefer the server's
    // returned document when present; otherwise reflect the requested value.
    const returned = isRecord(result[0]) ? (result[0] as Record<string, unknown>) : undefined;
    const updatedAttributes: Record<string, unknown> = {};
    for (const [path, value] of Object.entries(patch)) {
      const fromServer = returned ? getDotPath(returned, `system.${path}`) : undefined;
      updatedAttributes[path] = fromServer !== undefined ? fromServer : value;
    }

    return { success: true, updatedAttributes };
  }

  /**
   * The `system` data a token's actor actually has: the world actor's for a
   * linked token, or the base actor's merged with the token's own delta for an
   * unlinked one (each unlinked copy of a monster has its own HP).
   *
   * @returns undefined when the token or its actor isn't in the cache
   */
  getTokenActorSystem(tokenId: string, sceneId?: string): Record<string, unknown> | undefined {
    const found = this.findToken(tokenId, sceneId);
    if (!found) {
      return undefined;
    }
    const { token } = found;
    const actorId = typeof token.actorId === 'string' ? token.actorId : undefined;
    const base = actorId ? systemOf(this.getRawActor(actorId)) : undefined;
    if (token.actorLink === true) {
      return base;
    }
    const merged: Record<string, unknown> = base ? structuredClone(base) : {};
    const deltaSystem = isRecord(token.delta) ? token.delta.system : undefined;
    if (isRecord(deltaSystem)) {
      mergePatch(merged, structuredClone(deltaSystem));
    }
    return merged;
  }

  /**
   * A token and the actor it carries, checked.
   *
   * @param actorId - when given, must be the token's actor
   * @throws when the token isn't in the cache, has no actor, or carries another actor
   */
  resolveTokenActor(
    tokenId: string,
    sceneId?: string,
    actorId?: string,
  ): { scene: WorldScene; token: Record<string, unknown>; actorId: string; linked: boolean } {
    const found = this.findToken(tokenId, sceneId);
    if (!found) {
      throw new Error(`Token not found: ${tokenId}${sceneId ? ` in scene ${sceneId}` : ''}`);
    }
    const tokenActorId =
      typeof found.token.actorId === 'string' && found.token.actorId
        ? found.token.actorId
        : undefined;
    if (!tokenActorId) {
      throw new Error(`Token ${tokenId} has no actor`);
    }
    if (actorId !== undefined && actorId !== tokenActorId) {
      throw new Error(`Token ${tokenId} carries actor ${tokenActorId}, not ${actorId}`);
    }
    return { ...found, actorId: tokenActorId, linked: found.token.actorLink === true };
  }

  /**
   * A token's actor's effects, as FoundryVTT shows them (see {@link mergeDeltaEntries}).
   *
   * @returns undefined when the token isn't in the cache
   */
  getTokenActorEffects(tokenId: string, sceneId?: string): WorldEffect[] | undefined {
    const found = this.findToken(tokenId, sceneId);
    if (!found) {
      return undefined;
    }
    const base = this.tokenBaseActor(found.token)?.effects ?? [];
    return found.token.actorLink === true
      ? [...base]
      : mergeDeltaEntries(
          base,
          isRecord(found.token.delta) ? found.token.delta.effects : undefined,
        );
  }

  /**
   * A token's actor's items, as FoundryVTT shows them (see {@link mergeDeltaEntries}).
   *
   * @returns undefined when the token isn't in the cache
   */
  getTokenActorItems(tokenId: string, sceneId?: string): WorldItem[] | undefined {
    const found = this.findToken(tokenId, sceneId);
    if (!found) {
      return undefined;
    }
    const base = this.tokenBaseActor(found.token)?.items ?? [];
    return found.token.actorLink === true
      ? [...base]
      : mergeDeltaEntries(base, isRecord(found.token.delta) ? found.token.delta.items : undefined);
  }

  /**
   * A token's actor, mapped like {@link getActor}: for an unlinked token, its
   * base actor with the system data of {@link getTokenActorSystem} (and the
   * delta's name, when it has one). Read from the cache.
   *
   * @throws when the token or its base actor isn't in the cache
   */
  getTokenActor(tokenId: string, sceneId?: string): FoundryActor {
    const { token, actorId, linked } = this.resolveTokenActor(tokenId, sceneId);
    const base = this.getRawActor(actorId);
    if (!base) {
      throw new Error(`Actor not found: ${actorId}`);
    }
    if (linked) {
      return worldActorToFoundry(base);
    }
    const deltaName = isRecord(token.delta) ? token.delta.name : undefined;
    return worldActorToFoundry({
      ...base,
      ...(typeof deltaName === 'string' && deltaName ? { name: deltaName } : {}),
      system: this.getTokenActorSystem(tokenId, sceneId) ?? {},
    });
  }

  /** The world actor a token was made from, when it is cached. */
  private tokenBaseActor(token: Record<string, unknown>): WorldActor | undefined {
    return typeof token.actorId === 'string' ? this.getRawActor(token.actorId) : undefined;
  }

  /**
   * Patches attributes on one token's actor. WRITE — Socket.IO.
   *
   * A linked token shares its world actor, so this is {@link updateActorAttribute}.
   * An unlinked token's changes go to its ActorDelta, the way FoundryVTT's own
   * client sends them: an `ActorDelta` update parented to the token, with the
   * delta's id and `syntheticActorUpdate: true`. The base actor, and every other
   * token made from it, is untouched.
   */
  async updateTokenActorAttribute(
    sceneId: string,
    tokenId: string,
    patch: AttributePatch,
  ): Promise<ActorAttributeUpdateResult> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    if (!FOUNDRY_ID_PATTERN.test(tokenId)) {
      throw new Error(`Invalid tokenId format: ${tokenId}`);
    }
    if (!isRecord(patch) || Object.keys(patch).length === 0) {
      throw new Error('patch is required and must contain at least one attribute path');
    }
    const found = this.findToken(tokenId, sceneId);
    if (!found) {
      throw new Error(`Token not found: ${tokenId} in scene ${sceneId}`);
    }
    const { token } = found;
    const actorId = typeof token.actorId === 'string' ? token.actorId : undefined;
    if (!actorId) {
      throw new Error(`Token ${tokenId} has no actor`);
    }
    if (token.actorLink === true) {
      return this.updateActorAttribute(actorId, patch);
    }

    const actor = await this.getActor(actorId);
    validateAttributePatch(patch, actor, this.getTokenActorSystem(tokenId, sceneId));

    const delta = token.delta;
    const deltaId = isRecord(delta) && typeof delta._id === 'string' ? delta._id : tokenId;
    const update: Record<string, unknown> = { _id: deltaId };
    for (const [path, value] of Object.entries(patch)) {
      update[`system.${path}`] = value;
    }
    await this.modifyDocument('ActorDelta', 'update', {
      updates: [update],
      parentUuid: `Scene.${sceneId}.Token.${tokenId}`,
      syntheticActorUpdate: true,
      diff: true,
      recursive: true,
    });

    const after = this.getTokenActorSystem(tokenId, sceneId);
    const updatedAttributes: Record<string, unknown> = {};
    for (const [path, value] of Object.entries(patch)) {
      const cached = after ? getDotPath(after, path) : undefined;
      updatedAttributes[path] = cached !== undefined ? cached : value;
    }
    return { success: true, updatedAttributes };
  }

  /**
   * Creates a new top-level Actor document in the world.
   *
   * `Actor` is a top-level document (like `JournalEntry`), so the create
   * carries no `parentUuid`. Use to instantiate a permanent NPC/character
   * sheet in the sidebar, as opposed to {@link createActorStatusEffect} or
   * {@link createActorItem} which mutate an *existing* actor.
   *
   * @param name - actor display name
   * @param type - game-system actor type (e.g. "character", "npc")
   * @param system - optional system-specific data merged into `actor.system`
   * @param folder - optional 16-char Folder document id to file the actor under
   * @param flags - optional module flags (`actor.flags`), keyed by module id
   * @returns the newly created actor document
   */
  async createWorldActor(
    name: string,
    type: string,
    system?: Record<string, unknown>,
    folder?: string,
    flags?: Record<string, unknown>,
  ): Promise<WorldActor> {
    this.assertWriteable();
    if (!name || typeof name !== 'string') {
      throw new Error('name is required and must be a string');
    }
    if (!type || typeof type !== 'string') {
      throw new Error('type is required and must be a string');
    }
    if (folder !== undefined && !FOUNDRY_ID_PATTERN.test(folder)) {
      throw new Error(`Invalid folder format: ${folder}`);
    }
    if (flags !== undefined && (!isRecord(flags) || !Object.values(flags).every(isRecord))) {
      throw new Error('flags must be an object of per-module objects, e.g. {"my-module": {...}}');
    }
    const data: Record<string, unknown> = { name, type };
    if (system) {
      data.system = system;
    }
    if (folder) {
      data.folder = folder;
    }
    if (flags) {
      data.flags = flags;
    }
    const result = await this.modifyDocument('Actor', 'create', { data: [data] });
    return result[0] as WorldActor;
  }

  /**
   * Creates a new top-level Actor document AND seeds it with starting items
   * (skills, gear, weapons, cyberware, …) in one call, instead of a
   * `create_world_actor` round trip followed by one `create_actor_item` per
   * item. Pairs with {@link FoundryClient} schema introspection
   * (`get_document_schema` over the module bridge): call that once per
   * Actor/Item type to learn the real field names for `system`/item
   * `system`, then build the whole character in a single `createFullActor`
   * call.
   *
   * Item creation is best-effort per item, not atomic: the actor is always
   * created first (a failure there aborts the whole call, nothing to
   * return), but a bad item (e.g. a typo'd `type`) is reported in
   * `itemErrors` rather than losing the actor or the items that did succeed.
   *
   * @param name - actor display name
   * @param type - game-system actor type (e.g. "character", "npc")
   * @param options - `system` data, `folder`, and starting `items`
   * @returns the created actor, every successfully created item, and any
   *   per-item creation errors
   */
  async createFullActor(
    name: string,
    type: string,
    options: {
      system?: Record<string, unknown>;
      folder?: string;
      items?: Array<{ name: string; type: string; system?: Record<string, unknown> }>;
    } = {},
  ): Promise<{
    actor: WorldActor;
    items: FoundryItem[];
    itemErrors: Array<{ name: string; error: string }>;
  }> {
    const itemSeeds = options.items ?? [];
    for (const seed of itemSeeds) {
      if (!seed.name || typeof seed.name !== 'string') {
        throw new Error('Every item requires a name');
      }
      if (!seed.type || typeof seed.type !== 'string') {
        throw new Error(`Item "${seed.name}" requires a type`);
      }
    }

    const actor = await this.createWorldActor(name, type, options.system, options.folder);

    const items: FoundryItem[] = [];
    const itemErrors: Array<{ name: string; error: string }> = [];
    for (const seed of itemSeeds) {
      try {
        const itemDoc: Partial<FoundryItem> = { type: seed.type, name: seed.name };
        if (seed.system) {
          itemDoc.system = seed.system;
        }
        const item = await this.createActorItem(actor._id, { type: 'inline', item: itemDoc });
        items.push(item);
      } catch (error) {
        itemErrors.push({
          name: seed.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { actor, items, itemErrors };
  }

  /**
   * Creates a new top-level Actor from a raw document (as returned by the
   * module bridge's `get_compendium_document`) — the compendium→world import
   * path `spawn_token` cannot take, since `spawn_token` requires an actor
   * that already exists in the world.
   *
   * Cleaning keeps only `name`, `type`, `img`, `system`, `prototypeToken`,
   * `flags`, and (unless `includeEmbedded` is false) `items`/`effects`;
   * `_id`, `_stats`, and `sort` never survive a compendium copy, and the
   * compendium's own filing is dropped in favor of `options.folder`.
   *
   * `includeEmbedded: false` is the fallback for a system that rejects an
   * Actor create carrying embedded documents — the caller is then
   * responsible for seeding `items` one at a time via {@link createActorItem}.
   */
  async createActorFromData(
    data: Record<string, unknown>,
    options: { name?: string; folder?: string; includeEmbedded?: boolean } = {},
  ): Promise<WorldActor> {
    this.assertWriteable();
    if (options.folder !== undefined && !FOUNDRY_ID_PATTERN.test(options.folder)) {
      throw new Error(`Invalid folder format: ${options.folder}`);
    }

    const cleaned: Record<string, unknown> = {};
    for (const key of ['name', 'type', 'img', 'system', 'prototypeToken', 'flags'] as const) {
      if (data[key] !== undefined) {
        cleaned[key] = data[key];
      }
    }
    if (options.includeEmbedded !== false) {
      if (data.items !== undefined) {
        cleaned.items = data.items;
      }
      if (data.effects !== undefined) {
        cleaned.effects = data.effects;
      }
    }
    if (options.name) {
      cleaned.name = options.name;
    }
    if (options.folder) {
      cleaned.folder = options.folder;
    }

    if (typeof cleaned.name !== 'string' || !cleaned.name) {
      throw new Error('Compendium document has no usable name');
    }
    if (typeof cleaned.type !== 'string' || !cleaned.type) {
      throw new Error('Compendium document has no usable type');
    }

    const result = await this.modifyDocument('Actor', 'create', { data: [cleaned] });
    return result[0] as WorldActor;
  }

  // ==========================================================================
  // Item methods
  // ==========================================================================

  async searchItems(params: SearchItemsParams): Promise<ItemSearchResult> {
    if (this.config.apiKey) {
      return this.executeWithRetry(async () => {
        const response = await this.http.get('/api/items', { params });
        return response.data;
      });
    }

    if (!this.worldData) {
      return { items: [], total: 0, page: 1, limit: params.limit || 10, nextCursor: null };
    }

    let results = this.worldData.items;

    if (params.query) {
      const q = params.query.toLowerCase();
      results = results.filter((i) => i.name.toLowerCase().includes(q));
    }
    if (params.type) {
      const t = params.type.toLowerCase();
      results = results.filter((i) => i.type.toLowerCase() === t);
    }

    const total = results.length;
    const limit = params.limit || 10;
    const offset = decodeCursor(params.cursor);
    const items = results.slice(offset, offset + limit).map((i) => {
      const item: {
        _id: string;
        name: string;
        type: string;
        img?: string;
        description?: string;
        rarity?: string;
      } = {
        _id: i._id,
        name: i.name,
        type: i.type,
      };
      if (i.img) {
        item.img = i.img;
      }
      const sys = isRecord(i.system) ? (i.system as Record<string, unknown>) : {};
      const desc = extractString(sys, 'description', 'value') || extractString(sys, 'description');
      if (desc) {
        item.description = desc;
      }
      const rarity = extractString(sys, 'rarity');
      if (rarity) {
        item.rarity = rarity;
      }
      return item;
    });
    const nextOffset = offset + items.length;
    const nextCursor = nextOffset < total ? encodeCursor(nextOffset) : null;

    return { items, total, page: Math.floor(offset / limit) + 1, limit, nextCursor };
  }

  // ==========================================================================
  // Compendium methods
  // ==========================================================================

  /**
   * Searches FoundryVTT compendium packs by name and metadata.
   *
   * Compendium data is not present in the cached worldData snapshot, so this
   * read requires the REST API module (FOUNDRY_API_KEY). When the key is
   * absent it returns a graceful empty result with `restAvailable: false`
   * rather than throwing, mirroring the no-worldData behaviour of
   * {@link searchItems}/{@link searchActors}; the handler surfaces a note
   * explaining why no results were returned.
   */
  async searchCompendium(params: CompendiumSearchParams): Promise<CompendiumSearchResult> {
    const limit = params.limit ?? 20;
    const offset = decodeCursor(params.cursor);

    if (this.config.apiKey) {
      return this.executeWithRetry(async () => {
        // Translate the opaque cursor into a wire offset for the bridge.
        const { cursor: _cursor, ...rest } = params;
        const response = await this.http.get('/api/compendium/search', {
          params: { ...rest, limit, offset },
        });
        const data = (
          isRecord(response.data) ? response.data : {}
        ) as Partial<CompendiumSearchResult>;
        const results = data.results ?? [];
        const total = typeof data.total === 'number' ? data.total : results.length;
        const nextOffset = offset + results.length;
        return {
          results,
          total,
          page: Math.floor(offset / limit) + 1,
          limit,
          restAvailable: true,
          nextCursor: nextOffset < total ? encodeCursor(nextOffset) : null,
        };
      });
    }
    return { results: [], total: 0, page: 1, limit, restAvailable: false, nextCursor: null };
  }

  // ==========================================================================
  // Write helpers (Socket.IO `modifyDocument` — primary transport, PRD-003)
  // ==========================================================================

  /**
   * Guards a write operation. Writes require the `FOUNDRY_WRITE_ENABLED` opt-in
   * and an active authenticated Socket.IO session (the primary transport).
   * Throws a clear, actionable error otherwise.
   */
  private assertWriteable(): void {
    if (!this.config.writeEnabled) {
      throw new Error(
        'Write operations are disabled. Set FOUNDRY_WRITE_ENABLED=true to allow game-state mutation.',
      );
    }
    if (!this.socket?.connected) {
      throw new Error(
        'Write operations require an active Socket.IO connection to FoundryVTT (username/password mode).',
      );
    }
    this.assertAuthenticated();
  }

  /** Never send on an anonymous socket: FoundryVTT would not run it as our user. */
  private assertAuthenticated(): void {
    if (!this.canSendOnSocket()) {
      const { state, error } = this.connectionStatus();
      throw new RefusedError(
        `Reconnecting to FoundryVTT… (${state}${error ? `: ${error}` : ''}). Try again in a moment.`,
      );
    }
  }

  /**
   * Emits a Socket.IO event with an acknowledgement callback, resolving the
   * server's response and rejecting on timeout. Mirrors the ack pattern used by
   * the `world` event in {@link connectAndLoadWorld}/{@link refreshWorldData}.
   */
  private emitWithAck<T>(event: string, payload: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const socket = this.socket;
      if (!socket?.connected) {
        reject(new Error('Socket.IO is not connected'));
        return;
      }
      try {
        this.assertAuthenticated();
      } catch (error) {
        reject(error);
        return;
      }
      const timeoutMs = this.config.timeout || 10000;
      const timeout = setTimeout(
        () => reject(new Error(`Timeout waiting for '${event}' response (${timeoutMs}ms)`)),
        timeoutMs,
      );
      socket.emit(event, payload, (response: T) => {
        clearTimeout(timeout);
        resolve(response);
      });
    });
  }

  /**
   * Performs a FoundryVTT document mutation over Socket.IO using the core
   * `modifyDocument` protocol. The request shape is verified against the
   * v13.348 client source (`client/data/client-backend.mjs` `#buildRequest`,
   * `helpers/socket-interface.mjs` `dispatch`, `common/abstract/socket.mjs`).
   *
   * @param type - Document name ("Actor", "Item", …)
   * @param action - "create" | "update" | "delete"
   * @param operation - action-specific payload: `data` (create) / `updates`
   *   (update) / `ids` (delete), plus `parentUuid` for embedded documents.
   * @returns the server's `result` array (created/updated data, or deleted ids)
   */
  private async modifyDocument(
    type: string,
    action: 'create' | 'update' | 'delete',
    operation: Record<string, unknown>,
  ): Promise<unknown[]> {
    const request = {
      type,
      action,
      operation: { broadcast: true, pack: null, modifiedTime: Date.now(), ...operation },
    };
    const response = await this.emitWithAck<DocumentSocketResponse>('modifyDocument', request);
    // An operation with server-side side effects (activating a scene
    // deactivates the others, …) is answered `{results: [...sideEffects,
    // response]}` by FoundryVTT v14 instead of the bare response.
    const responses: DocumentSocketResponse[] = Array.isArray(response?.results)
      ? response.results.filter(isRecord)
      : [response];
    const failed = responses.find((r) => r?.error);
    if (failed) {
      throw new Error(
        `FoundryVTT rejected ${action} ${type}: ${failed.error?.message || 'unknown error'}`,
      );
    }
    const main = responses[responses.length - 1];
    const result = Array.isArray(main?.result) ? main.result : [];
    // Side effects are not echoed back to this client either.
    for (const sideEffect of responses.slice(0, -1)) {
      const broadcast = parseDocumentBroadcast(sideEffect);
      if (broadcast) {
        this.changeCache((worldData) => applyDocumentBroadcast(worldData, broadcast));
      }
    }
    // FoundryVTT does not echo a client's own writes back on the
    // `modifyDocument` broadcast channel (see world-cache.ts's header
    // comment) - without this, every write here left `worldData` stale
    // for the rest of the session until an unrelated broadcast or an
    // explicit refreshWorldData() resynced it. Applying this response
    // through the same `applyDocumentBroadcast` broadcasts use is safe
    // unconditionally: it is idempotent by construction (upserts by _id,
    // tolerates an already-gone delete id), so if Foundry *does* also
    // broadcast this write back later, re-applying it is a no-op.
    const parentUuid = operation.parentUuid;
    const ownWrite: DocumentBroadcast = {
      type,
      action,
      result,
      ...(typeof parentUuid === 'string' && parentUuid ? { parentUuid } : {}),
    };
    this.changeCache((worldData) => applyDocumentBroadcast(worldData, ownWrite));
    return result;
  }

  // ==========================================================================
  // Item mutation methods (WRITE — Socket.IO modifyDocument)
  // ==========================================================================

  /**
   * The parent of an item write: `Actor.<actorId>`, or, for one token, that
   * token's actor - its ActorDelta when unlinked (see {@link toDeltaParentUuid}).
   *
   * @throws when the token isn't in the cache or carries another actor
   */
  private itemParentUuid(actorId: string, token?: ActorTokenRef): string {
    if (!token) {
      return `Actor.${actorId}`;
    }
    if (!FOUNDRY_ID_PATTERN.test(token.sceneId)) {
      throw new Error(`Invalid sceneId format: ${token.sceneId}`);
    }
    if (!FOUNDRY_ID_PATTERN.test(token.tokenId)) {
      throw new Error(`Invalid tokenId format: ${token.tokenId}`);
    }
    return this.toDeltaParentUuid(`Scene.${token.sceneId}.Token.${token.tokenId}.Actor.${actorId}`);
  }

  /**
   * Creates a new item on an actor via the `modifyDocument` socket protocol.
   *
   * @param actorId - 16-char alphanumeric actor document id
   * @param source - inline item document or compendium source
   * @param token - one token whose actor gets the item instead (only that
   *   token, for an unlinked one)
   * @returns the newly created item document
   */
  async createActorItem(
    actorId: string,
    source: ActorItemCreateSource,
    token?: ActorTokenRef,
  ): Promise<FoundryItem> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(actorId)) {
      throw new Error(`Invalid actorId format: ${actorId}`);
    }
    const itemData = source.type === 'inline' ? source.item : {};
    const result = await this.modifyDocument('Item', 'create', {
      data: [itemData],
      parentUuid: this.itemParentUuid(actorId, token),
    });
    return result[0] as FoundryItem;
  }

  /**
   * Applies a JSON merge patch to an item owned by an actor.
   *
   * The `patch` is merged into the item's `system` data (recursively, so nested
   * paths like the D&D 5e v4+ `activities.{id}.consumption.targets` are
   * preserved). Performed via the `modifyDocument` socket protocol.
   *
   * @param actorId - 16-char alphanumeric actor document id
   * @param itemId - 16-char alphanumeric item document id
   * @param patch - shallow/nested JSON merge patch applied to `item.system`
   * @param token - one token whose actor's item to change instead; for an
   *   unlinked token, an item it inherits is copied into its delta by the
   *   server, so the base actor and its other tokens keep theirs
   * @returns the server's answer (only the changed fields) with the item's
   *   `name` and `type` read back from the cache, which the answer has already
   *   updated
   */
  async updateActorItem(
    actorId: string,
    itemId: string,
    patch: Record<string, unknown>,
    token?: ActorTokenRef,
  ): Promise<FoundryItem> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(actorId)) {
      throw new Error(`Invalid actorId format: ${actorId}`);
    }
    if (!FOUNDRY_ID_PATTERN.test(itemId)) {
      throw new Error(`Invalid itemId format: ${itemId}`);
    }
    const result = await this.modifyDocument('Item', 'update', {
      updates: [{ _id: itemId, system: patch }],
      parentUuid: this.itemParentUuid(actorId, token),
      diff: true,
      recursive: true,
    });
    const cached = (
      token
        ? this.getTokenActorItems(token.tokenId, token.sceneId)
        : this.getRawActor(actorId)?.items
    )?.find((item) => item._id === itemId);
    return {
      ...(result[0] as FoundryItem),
      ...(cached ? { name: cached.name, type: cached.type } : {}),
    };
  }

  /**
   * Deletes an item owned by an actor via the `modifyDocument` socket protocol.
   *
   * @param actorId - 16-char alphanumeric actor document id
   * @param itemId - 16-char alphanumeric item document id
   * @param token - one token whose actor loses the item instead; for an
   *   unlinked token, the server tombstones an inherited item in its delta
   */
  async deleteActorItem(actorId: string, itemId: string, token?: ActorTokenRef): Promise<void> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(actorId)) {
      throw new Error(`Invalid actorId format: ${actorId}`);
    }
    if (!FOUNDRY_ID_PATTERN.test(itemId)) {
      throw new Error(`Invalid itemId format: ${itemId}`);
    }
    await this.modifyDocument('Item', 'delete', {
      ids: [itemId],
      parentUuid: this.itemParentUuid(actorId, token),
    });
  }

  // ==========================================================================
  // Combat mutation methods (WRITE — Socket.IO modifyDocument, FR-018)
  // ==========================================================================

  /**
   * Updates the active combat's turn/round pointers (FR-018).
   *
   * `Combat` is a top-level document, so the update carries no `parentUuid`.
   * The patch fields map directly onto the Combat document (`turn`, `round`).
   *
   * @param combatId - 16-char alphanumeric Combat document id
   * @param patch - turn and/or round to set on the combat
   * @returns the updated combat document
   */
  async updateCombat(combatId: string, patch: { turn?: number; round?: number }): Promise<unknown> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(combatId)) {
      throw new Error(`Invalid combatId format: ${combatId}`);
    }
    const result = await this.modifyDocument('Combat', 'update', {
      updates: [{ _id: combatId, ...patch }],
      diff: true,
      recursive: true,
    });
    return result[0];
  }

  /**
   * Ends (deletes) the active combat encounter (FR-018).
   *
   * @param combatId - 16-char alphanumeric Combat document id
   */
  async endCombat(combatId: string): Promise<void> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(combatId)) {
      throw new Error(`Invalid combatId format: ${combatId}`);
    }
    await this.modifyDocument('Combat', 'delete', { ids: [combatId] });
  }

  /**
   * Sets a combatant's initiative (FR-018).
   *
   * `Combatant` is an embedded document inside `Combat`, so the update is sent
   * with `parentUuid: "Combat.<combatId>"`.
   *
   * @param combatId - 16-char alphanumeric Combat document id (the parent)
   * @param combatantId - 16-char alphanumeric Combatant document id
   * @param initiative - finite initiative value to assign
   * @returns the updated combatant document
   */
  async setCombatantInitiative(
    combatId: string,
    combatantId: string,
    initiative: number,
  ): Promise<unknown> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(combatId)) {
      throw new Error(`Invalid combatId format: ${combatId}`);
    }
    if (!FOUNDRY_ID_PATTERN.test(combatantId)) {
      throw new Error(`Invalid combatantId format: ${combatantId}`);
    }
    if (typeof initiative !== 'number' || !Number.isFinite(initiative)) {
      throw new Error(`Invalid initiative: ${initiative} (must be a finite number)`);
    }
    const result = await this.modifyDocument('Combatant', 'update', {
      updates: [{ _id: combatantId, initiative }],
      parentUuid: `Combat.${combatId}`,
      diff: true,
      recursive: true,
    });
    return result[0];
  }

  /**
   * Starts a new combat encounter and seeds its combatants (FR-018, laurigates/foundryvtt-mcp#172).
   *
   * Two-step `modifyDocument` flow:
   *   1. Create the top-level `Combat` document (no `parentUuid`), activated on
   *      the given scene, and read its `_id` from the response.
   *   2. Create the embedded `Combatant` documents with
   *      `parentUuid: "Combat.<combatId>"` (mirrors the Combatant→Combat embed
   *      used by {@link setCombatantInitiative}).
   *
   * The create wire shape is verified against the v13.348 client source per
   * `.claude/rules/foundry-write-protocol.md`; smoke-test one live round-trip
   * when changing it.
   *
   * @param sceneId - 16-char alphanumeric Scene document id the combat runs on
   * @param combatants - combatant seeds ({ tokenId, sceneId, actorId? })
   * @returns the new combat id and the number of combatants created
   */
  async startCombat(
    sceneId: string,
    combatants: Array<{ tokenId: string; sceneId: string; actorId?: string | undefined }>,
  ): Promise<{ combatId: string; combatantCount: number }> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    for (const c of combatants) {
      if (!FOUNDRY_ID_PATTERN.test(c.tokenId)) {
        throw new Error(`Invalid tokenId format: ${c.tokenId}`);
      }
    }

    const created = await this.modifyDocument('Combat', 'create', {
      data: [{ scene: sceneId, active: true }],
    });
    const combat = created[0] as { _id?: string } | undefined;
    const combatId = combat?._id;
    if (!combatId) {
      throw new Error('FoundryVTT did not return a Combat id after create');
    }

    if (combatants.length > 0) {
      await this.modifyDocument('Combatant', 'create', {
        data: combatants,
        parentUuid: `Combat.${combatId}`,
      });
    }

    // Begin the encounter as Foundry's own "Begin Combat" does (Combat#startCombat);
    // a combat left at round 0 hasn't started, and turn advances are meaningless.
    await this.modifyDocument('Combat', 'update', {
      updates: [{ _id: combatId, round: 1, turn: 0 }],
    });

    return { combatId, combatantCount: combatants.length };
  }

  // ==========================================================================
  // Token mutation methods (WRITE — Socket.IO modifyDocument, FR-019)
  // ==========================================================================

  /**
   * Locates a token (and the scene it lives on) in the cached worldData.
   *
   * `Token` is an embedded document of `Scene`; worldData carries each scene's
   * tokens as raw records. When `sceneId` is omitted the search spans every
   * scene, so a token can be moved/affected without first resolving its scene.
   *
   * @param tokenId - 16-char alphanumeric Token document id
   * @param sceneId - optional Scene id to scope the search to
   * @returns the owning scene and the raw token record, or null if not found
   */
  findToken(
    tokenId: string,
    sceneId?: string,
  ): { scene: WorldScene; token: Record<string, unknown> } | null {
    if (!this.worldData) {
      return null;
    }
    const scenes = sceneId
      ? this.worldData.scenes.filter((s) => s._id === sceneId)
      : this.worldData.scenes;
    for (const scene of scenes) {
      const token = scene.tokens?.find((t) => (t as { _id?: string })._id === tokenId);
      if (token) {
        return { scene, token };
      }
    }
    return null;
  }

  /**
   * Moves a token to new x/y coordinates (FR-019).
   *
   * `Token` is an embedded document of `Scene`, so the update is sent with
   * `parentUuid: "Scene.<sceneId>"` (mirrors the Combatant→Combat embed). The
   * wire shape is verified against the v13.348 client source per
   * `.claude/rules/foundry-write-protocol.md`.
   *
   * @param sceneId - 16-char alphanumeric Scene document id (the parent)
   * @param tokenId - 16-char alphanumeric Token document id
   * @param x - target x pixel coordinate (finite number)
   * @param y - target y pixel coordinate (finite number)
   * @returns the updated token document
   */
  async moveToken(sceneId: string, tokenId: string, x: number, y: number): Promise<unknown> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    if (!FOUNDRY_ID_PATTERN.test(tokenId)) {
      throw new Error(`Invalid tokenId format: ${tokenId}`);
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`Invalid coordinates: (${x}, ${y}) — x and y must be finite numbers`);
    }
    const result = await this.modifyDocument('Token', 'update', {
      updates: [{ _id: tokenId, x, y }],
      parentUuid: `Scene.${sceneId}`,
      diff: true,
      recursive: true,
    });
    return result[0];
  }

  /**
   * Updates a token's vision and/or light emission properties.
   *
   * @param sceneId - 16-char alphanumeric Scene document id
   * @param tokenId - 16-char alphanumeric Token document id
   * @param patch - vision (sight.*) and light (light.*) settings
   */
  async updateTokenVision(
    sceneId: string,
    tokenId: string,
    patch: {
      sightEnabled?: boolean;
      sightRange?: number;
      sightAngle?: number;
      visionMode?: string;
      lightDim?: number;
      lightBright?: number;
      lightColor?: string;
      lightAngle?: number;
      lightAnimationType?: string;
    },
  ): Promise<unknown> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    if (!FOUNDRY_ID_PATTERN.test(tokenId)) {
      throw new Error(`Invalid tokenId format: ${tokenId}`);
    }
    if (
      patch.sightEnabled === undefined &&
      patch.sightRange === undefined &&
      patch.sightAngle === undefined &&
      patch.visionMode === undefined &&
      patch.lightDim === undefined &&
      patch.lightBright === undefined &&
      patch.lightColor === undefined &&
      patch.lightAngle === undefined &&
      patch.lightAnimationType === undefined
    ) {
      throw new Error('patch is required and must contain at least one vision or light field');
    }
    if (patch.lightColor && !HEX_COLOR_PATTERN.test(patch.lightColor)) {
      throw new Error(
        `Invalid lightColor format: ${patch.lightColor} — must be a 6-digit hex color`,
      );
    }

    const update: Record<string, unknown> = { _id: tokenId };
    let sightEnabled = patch.sightEnabled;
    if (patch.sightRange !== undefined && patch.sightRange > 0 && sightEnabled === undefined) {
      sightEnabled = true;
    }
    if (sightEnabled !== undefined) {
      update['sight.enabled'] = sightEnabled;
    }
    if (patch.sightRange !== undefined) {
      update['sight.range'] = patch.sightRange;
    }
    if (patch.sightAngle !== undefined) {
      update['sight.angle'] = patch.sightAngle;
    }
    if (patch.visionMode !== undefined) {
      update['sight.visionMode'] = patch.visionMode;
    }
    if (patch.lightDim !== undefined) {
      update['light.dim'] = patch.lightDim;
    }
    if (patch.lightBright !== undefined) {
      update['light.bright'] = patch.lightBright;
    }
    if (patch.lightColor !== undefined) {
      update['light.color'] = patch.lightColor;
    }
    if (patch.lightAngle !== undefined) {
      update['light.angle'] = patch.lightAngle;
    }
    if (patch.lightAnimationType !== undefined) {
      update['light.animation.type'] = patch.lightAnimationType;
    }

    const result = await this.modifyDocument('Token', 'update', {
      updates: [update],
      parentUuid: `Scene.${sceneId}`,
      diff: true,
      recursive: true,
    });
    return result[0];
  }

  /**
   * Rewrites an unlinked token's synthetic-actor UUID to its ActorDelta UUID.
   *
   * FoundryVTT keeps an unlinked token's own items and effects on the token's
   * ActorDelta, and its client sends embedded writes for a token actor with
   * `parentUuid: "Scene.<sid>.Token.<tid>.ActorDelta.<did>"`
   * (ClientDatabaseBackend#adjustActorDeltaRequest). v14 rejects the
   * `...Token.<tid>.Actor.<aid>` form outright. The delta's id defaults to the
   * token's id. A linked token shares its world actor, so it gets
   * `Actor.<aid>`. Any other UUID is returned unchanged.
   *
   * @throws when the token isn't in the cache or carries another actor
   */
  private toDeltaParentUuid(parentActorUuid: string): string {
    const match =
      /^Scene\.([a-zA-Z0-9]{16})\.Token\.([a-zA-Z0-9]{16})\.Actor\.([a-zA-Z0-9]{16})$/.exec(
        parentActorUuid,
      );
    if (!match) {
      return parentActorUuid;
    }
    const [, sceneId = '', tokenId = '', actorId = ''] = match;
    const { token, linked } = this.resolveTokenActor(tokenId, sceneId, actorId);
    if (linked) {
      return `Actor.${actorId}`;
    }
    const delta = token.delta;
    const deltaId = isRecord(delta) && typeof delta._id === 'string' ? delta._id : tokenId;
    return `Scene.${sceneId}.Token.${tokenId}.ActorDelta.${deltaId}`;
  }

  /**
   * Creates a status-effect `ActiveEffect` on a token's actor (FR-019).
   *
   * `parentActorUuid` takes one of two forms:
   *  - `Actor.<id>` for a world actor
   *  - `Scene.<sid>.Token.<tid>.Actor.<aid>` for a token's actor.
   *
   * The create is sent with the parent {@link toDeltaParentUuid} makes of it:
   * `Actor.<aid>` for a world actor or a linked token, and
   * `Scene.<sid>.Token.<tid>.ActorDelta.<did>` for an unlinked token (its
   * per-token delta). A token that isn't cached or carries another actor is
   * refused before anything is sent.
   *
   * The effect carries a `statuses` array, matching how FoundryVTT v11+ models
   * conditions (`Actor#toggleStatusEffect` toggles by this field).
   *
   * @param parentActorUuid - the token actor's parent UUID (see forms above)
   * @param statusId - condition id (e.g. "prone", "stunned")
   * @param options - optional display `name` (defaults to `statusId`) and `img`
   * @returns the newly created ActiveEffect document
   */
  async createActorStatusEffect(
    parentActorUuid: string,
    statusId: string,
    options: { name?: string; img?: string } = {},
  ): Promise<WorldEffect> {
    this.assertWriteable();
    if (!TOKEN_ACTOR_UUID_PATTERN.test(parentActorUuid)) {
      throw new Error(`Invalid actor UUID format: ${parentActorUuid}`);
    }
    if (!statusId || typeof statusId !== 'string') {
      throw new Error('statusId is required and must be a string');
    }
    const effectData: Record<string, unknown> = {
      name: options.name ?? statusId,
      statuses: [statusId],
      // ACTIVE_EFFECT_SHOW_ICON.ALWAYS, as ActiveEffect.fromStatusEffect sets.
      // The default (CONDITIONAL) only draws the token icon for temporary
      // effects, and since v14 a status alone no longer makes one temporary.
      showIcon: 2,
    };
    if (options.img) {
      effectData.img = options.img;
    }
    const result = await this.modifyDocument('ActiveEffect', 'create', {
      data: [effectData],
      parentUuid: this.toDeltaParentUuid(parentActorUuid),
    });
    return result[0] as WorldEffect;
  }

  /**
   * Deletes an `ActiveEffect` from a token's actor (FR-019), e.g. to clear a
   * status condition. Accepts the same parent-UUID forms as
   * {@link createActorStatusEffect}.
   *
   * @param parentActorUuid - the token actor's parent UUID
   * @param effectId - 16-char alphanumeric ActiveEffect document id
   */
  async deleteActorEffect(parentActorUuid: string, effectId: string): Promise<void> {
    this.assertWriteable();
    if (!TOKEN_ACTOR_UUID_PATTERN.test(parentActorUuid)) {
      throw new Error(`Invalid actor UUID format: ${parentActorUuid}`);
    }
    if (!FOUNDRY_ID_PATTERN.test(effectId)) {
      throw new Error(`Invalid effectId format: ${effectId}`);
    }
    await this.modifyDocument('ActiveEffect', 'delete', {
      ids: [effectId],
      parentUuid: this.toDeltaParentUuid(parentActorUuid),
    });
  }

  /**
   * Creates a general-purpose `ActiveEffect` on a token's actor — mechanical
   * buffs/debuffs with `changes`/`duration`, not just the name+`statuses`
   * toggle {@link createActorStatusEffect} writes. Accepts the same
   * parent-UUID forms.
   *
   * @param parentActorUuid - the token actor's parent UUID
   * @param effect - effect fields; `name` is required
   * @returns the newly created ActiveEffect document
   */
  async createActorEffect(parentActorUuid: string, effect: ActorEffectInput): Promise<WorldEffect> {
    this.assertWriteable();
    if (!TOKEN_ACTOR_UUID_PATTERN.test(parentActorUuid)) {
      throw new Error(`Invalid actor UUID format: ${parentActorUuid}`);
    }
    if (!effect.name || typeof effect.name !== 'string') {
      throw new Error('effect.name is required and must be a string');
    }
    const effectData: Record<string, unknown> = { name: effect.name };
    if (effect.img) {
      effectData.img = effect.img;
    }
    if (effect.description) {
      effectData.description = effect.description;
    }
    if (effect.disabled !== undefined) {
      effectData.disabled = effect.disabled;
    }
    if (effect.statuses) {
      effectData.statuses = effect.statuses;
      if (effect.statuses.length > 0) {
        // ACTIVE_EFFECT_SHOW_ICON.ALWAYS, as createActorStatusEffect sets: since
        // v14 a status alone no longer makes the effect temporary, so the
        // default (CONDITIONAL) would hide its token icon.
        effectData.showIcon = 2;
      }
    }
    if (effect.duration) {
      effectData.duration = effect.duration;
    }
    const changes = mapEffectChanges(effect.changes);
    if (changes) {
      effectData.changes = changes;
    }
    const result = await this.modifyDocument('ActiveEffect', 'create', {
      data: [effectData],
      parentUuid: this.toDeltaParentUuid(parentActorUuid),
    });
    return result[0] as WorldEffect;
  }

  /**
   * Updates a general-purpose `ActiveEffect` on a token's actor. Every field
   * on `patch` is optional and replaces the corresponding field on the
   * existing document; omitted fields are left as they are.
   *
   * @param parentActorUuid - the token actor's parent UUID
   * @param effectId - 16-char alphanumeric ActiveEffect document id
   * @param patch - fields to replace on the existing effect
   */
  async updateActorEffect(
    parentActorUuid: string,
    effectId: string,
    patch: ActorEffectInput,
  ): Promise<WorldEffect> {
    this.assertWriteable();
    if (!TOKEN_ACTOR_UUID_PATTERN.test(parentActorUuid)) {
      throw new Error(`Invalid actor UUID format: ${parentActorUuid}`);
    }
    if (!FOUNDRY_ID_PATTERN.test(effectId)) {
      throw new Error(`Invalid effectId format: ${effectId}`);
    }
    const update: Record<string, unknown> = { _id: effectId };
    if (patch.name !== undefined) {
      update.name = patch.name;
    }
    if (patch.img !== undefined) {
      update.img = patch.img;
    }
    if (patch.description !== undefined) {
      update.description = patch.description;
    }
    if (patch.disabled !== undefined) {
      update.disabled = patch.disabled;
    }
    if (patch.statuses !== undefined) {
      update.statuses = patch.statuses;
    }
    if (patch.duration !== undefined) {
      update.duration = patch.duration;
    }
    const changes = mapEffectChanges(patch.changes);
    if (changes) {
      update.changes = changes;
    }
    const result = await this.modifyDocument('ActiveEffect', 'update', {
      updates: [update],
      parentUuid: this.toDeltaParentUuid(parentActorUuid),
    });
    return result[0] as WorldEffect;
  }

  /**
   * Lists the `ActiveEffect`s cached on a world-linked actor. A cache read,
   * not a socket round trip — and consequently only reaches a top-level
   * `Actor` document (`worldData.actors`), not an unlinked token's synthetic
   * per-token actor, which is never a `worldData.actors` entry of its own.
   *
   * @param actorId - 16-char alphanumeric actor document id
   */
  listActorEffects(actorId: string): WorldEffect[] {
    if (!FOUNDRY_ID_PATTERN.test(actorId)) {
      throw new Error(`Invalid actorId format: ${actorId}`);
    }
    const actor = this.worldData?.actors.find((candidate) => candidate._id === actorId);
    if (!actor) {
      throw new Error(`Actor not found: ${actorId}`);
    }
    return actor.effects ?? [];
  }

  // ==========================================================================
  // Scene methods
  // ==========================================================================

  async getCurrentScene(sceneId?: string): Promise<FoundryScene> {
    if (sceneId !== undefined && !FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    if (this.config.apiKey) {
      return this.executeWithRetry(async () => {
        const endpoint = sceneId ? `/api/scenes/${sceneId}` : '/api/scenes/current';
        const response = await this.http.get(endpoint);
        return response.data;
      });
    }

    if (!this.worldData) {
      throw new Error('Not connected — no world data available');
    }

    let scene: WorldScene | undefined;
    if (sceneId) {
      scene = this.worldData.scenes.find((s) => s._id === sceneId);
    } else {
      scene = this.worldData.scenes.find((s) => s.active);
    }

    if (!scene) {
      throw new Error(sceneId ? `Scene not found: ${sceneId}` : 'No active scene');
    }

    return worldSceneToFoundry(scene);
  }

  async getScene(sceneId: string): Promise<FoundryScene> {
    return this.getCurrentScene(sceneId);
  }

  getScenes(): WorldScene[] {
    return this.worldData?.scenes || [];
  }

  // ==========================================================================
  // World info
  // ==========================================================================

  async getWorldInfo(): Promise<FoundryWorld> {
    if (this.config.apiKey) {
      return this.executeWithRetry(async () => {
        const response = await this.http.get('/api/world');
        return response.data;
      });
    }

    if (!this.worldData) {
      return {
        id: 'unknown',
        title: 'Not connected',
        description: 'Connect to FoundryVTT to retrieve world information',
        system: 'unknown',
        coreVersion: 'unknown',
        systemVersion: 'unknown',
        playtime: 0,
        created: new Date().toISOString(),
        modified: new Date().toISOString(),
      };
    }

    const w = this.worldData.world as Record<string, unknown>;
    const s = this.worldData.system as Record<string, unknown>;
    const r = this.worldData.release as Record<string, unknown>;

    return {
      id: (w.id as string) || 'unknown',
      title: (w.title as string) || 'Unknown World',
      description: (w.description as string) || '',
      system: (s.id as string) || 'unknown',
      coreVersion: (r.version as string) || (r.generation as string) || 'unknown',
      systemVersion: (s.version as string) || 'unknown',
      playtime: 0,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
    };
  }

  // ==========================================================================
  // Combat
  // ==========================================================================

  getCombatState(): WorldCombat | null {
    if (!this.worldData) {
      return null;
    }
    return this.worldData.combats.find((c) => c.active) ?? null;
  }

  // ==========================================================================
  // Chat messages
  // ==========================================================================

  getChatMessages(limit = 20): WorldMessage[] {
    if (!this.worldData) {
      return [];
    }
    return this.worldData.messages.slice(-limit);
  }

  // ==========================================================================
  // Users
  // ==========================================================================

  getUsers(): { users: WorldUser[]; activeUsers: string[] } {
    if (!this.worldData) {
      return { users: [], activeUsers: [] };
    }
    return {
      users: this.worldData.users,
      activeUsers: this.worldData.activeUsers,
    };
  }

  /**
   * Changes a user's role/permission level.
   *
   * Guarded against self-lockout: refuses to demote the connected MCP user
   * below `assistant` (3), which would immediately revoke write access and
   * break subsequent operations.
   *
   * @param userId - 16-char alphanumeric User document id
   * @param role - named permission tier
   */
  async setUserRole(userId: string, role: keyof typeof USER_ROLES): Promise<unknown> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(userId)) {
      throw new Error(`Invalid userId format: ${userId}`);
    }
    const numericRole = USER_ROLES[role];
    if (numericRole === undefined) {
      throw new Error(
        `Invalid role "${role}": expected one of ${Object.keys(USER_ROLES).join(', ')}`,
      );
    }
    if (userId === this.worldData?.userId && numericRole < USER_ROLES.assistant) {
      throw new Error(
        `Cannot demote the connected user (${userId}) below assistant role: self-demotion would lock the MCP server out of GM permissions.`,
      );
    }
    // FoundryVTT only lets a user grant roles up to its own
    // (common/documents/user.mjs `#canUpdate`): refuse before asking it.
    const account = this.accountInfo();
    if (account?.role != null && numericRole > account.role) {
      throw new RefusedError(
        `The connector's account "${account.name}" is ${roleLabel(account.role)}: FoundryVTT only ` +
          `lets a user grant roles up to its own, so it cannot grant ${roleLabel(numericRole)}. ` +
          'Change this role in FoundryVTT as a Gamemaster.',
      );
    }
    const result = await this.modifyDocument('User', 'update', {
      updates: [{ _id: userId, role: numericRole }],
      diff: true,
      recursive: true,
    });
    return result[0];
  }

  // ==========================================================================
  // Journals
  // ==========================================================================

  getJournals(): WorldJournal[] {
    return this.worldData?.journal || [];
  }

  searchJournals(query: string): WorldJournal[] {
    if (!this.worldData) {
      return [];
    }
    const q = query.toLowerCase();
    return this.worldData.journal.filter((j) => {
      if (j.name.toLowerCase().includes(q)) {
        return true;
      }
      return j.pages?.some(
        (p) => p.name.toLowerCase().includes(q) || p.text?.content?.toLowerCase().includes(q),
      );
    });
  }

  getJournal(journalId: string): WorldJournal | undefined {
    return this.worldData?.journal.find((j) => j._id === journalId);
  }

  /**
   * Reads one journal entry, with all its pages, from the server rather than
   * the cache, and stores it in the cache.
   *
   * Uses `modifyDocument` with `action: "get"` and `query: { _id }`: the v14
   * server answers with the entry and its embedded pages, never broadcast.
   * (A `get` on `JournalEntryPage` ignores `query` and returns every page of
   * the parent, so one entry read covers every page need.) Only this entry is
   * fresh afterwards, so `worldDataStale` is left as it was. When the `get`
   * itself fails, a full `refreshWorldData()` stands in for it.
   *
   * @returns the entry, or `undefined` when the server has no such entry
   */
  async fetchJournalEntry(journalId: string): Promise<WorldJournal | undefined> {
    if (!FOUNDRY_ID_PATTERN.test(journalId)) {
      throw new Error(`Invalid journalId format: ${journalId}`);
    }

    let response: DocumentSocketResponse;
    try {
      response = await this.emitWithAck<DocumentSocketResponse>('modifyDocument', {
        type: 'JournalEntry',
        action: 'get',
        operation: { query: { _id: journalId }, pack: null },
      });
      if (response?.error) {
        throw new Error(response.error.message || 'unknown error');
      }
    } catch (error) {
      logger.warn('Server read of a journal entry failed — refreshing the whole world instead', {
        journalId,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.refreshWorldData();
      return this.getJournal(journalId);
    }

    const raw = Array.isArray(response.result) ? response.result[0] : undefined;
    if (raw === undefined) {
      // Gone on the server: drop it from the cache too.
      this.changeCache((worldData) => {
        worldData.journal = worldData.journal.filter((j) => j._id !== journalId);
      });
      return undefined;
    }
    const parsed = FetchedJournalSchema.safeParse(raw);
    if (!parsed.success || parsed.data._id !== journalId) {
      throw new Error(`Unexpected server answer when reading journal ${journalId}`);
    }
    // Validated above; the cast only bridges `exactOptionalPropertyTypes`.
    const journal = parsed.data as WorldJournal;
    this.changeCache((worldData) => {
      const index = worldData.journal.findIndex((j) => j._id === journalId);
      if (index === -1) {
        worldData.journal.push(journal);
      } else {
        worldData.journal[index] = journal;
      }
    });
    return journal;
  }

  // ==========================================================================
  // Journal mutation methods (WRITE — Socket.IO modifyDocument)
  // ==========================================================================

  /**
   * Creates a new JournalEntry with one or more text pages.
   *
   * `JournalEntry` is a top-level document (unlike Item/ActiveEffect, which
   * are embedded in an Actor), so the create carries no `parentUuid` —
   * mirrors {@link startCombat}'s top-level Combat create. Each entry in
   * `pages` is mapped to Foundry's native `JournalEntryPage` text-page shape,
   * with an explicit `sort` so the pages render in the order supplied.
   *
   * @param name - journal entry title
   * @param pages - one or more pages (name + content); at least one required
   * @param folder - optional 16-char Folder document id to file the entry under
   * @param visibility - who can see the entry (laurigates/foundryvtt-mcp#204); omitted means GM-only,
   *   which is FoundryVTT's default for a newly created document
   * @returns the newly created journal entry document
   */
  async createJournalEntry(
    name: string,
    pages: JournalPageCreateSource[],
    folder?: string,
    visibility?: DocumentVisibility,
  ): Promise<WorldJournal> {
    this.assertWriteable();
    if (!name || typeof name !== 'string') {
      throw new Error('name is required and must be a string');
    }
    if (!Array.isArray(pages) || pages.length === 0) {
      throw new Error('pages is required and must contain at least one page');
    }
    if (folder !== undefined && !FOUNDRY_ID_PATTERN.test(folder)) {
      throw new Error(`Invalid folder format: ${folder}`);
    }
    if (visibility !== undefined && !(visibility in VISIBILITY_LEVELS)) {
      throw new Error(
        `Invalid visibility: ${visibility}. Expected one of: ${Object.keys(VISIBILITY_LEVELS).join(', ')}`,
      );
    }

    const data: Record<string, unknown> = {
      name,
      pages: pages.map((p, i) => ({
        name: p.name,
        type: 'text',
        text: { content: p.content, format: 1 },
        sort: (i + 1) * SORT_INTEGER_DENSITY,
      })),
    };
    if (folder) {
      data.folder = folder;
    }
    if (visibility) {
      data.ownership = { default: VISIBILITY_LEVELS[visibility] };
    }

    const result = await this.modifyDocument('JournalEntry', 'create', {
      data: [data],
    });
    return result[0] as WorldJournal;
  }

  /**
   * Renames a journal page and/or replaces its body.
   *
   * `JournalEntryPage` is embedded in a `JournalEntry`, so the update carries
   * `parentUuid: "JournalEntry.<journalId>"` (mirrors {@link updateActorItem}).
   * `content` replaces `text.content` wholesale, so it requires
   * `expectedVersion` — the token get_journal `raw: true` printed for the body
   * the caller rewrote — and is refused when the page changed since.
   * See {@link writeJournalPage} for the read-back, local copy and watch.
   *
   * @param journalId - 16-char alphanumeric JournalEntry document id
   * @param pageId - 16-char alphanumeric JournalEntryPage document id
   * @param patch - new name and/or HTML content; at least one required
   */
  async updateJournalPage(
    journalId: string,
    pageId: string,
    patch: JournalPageUpdate,
  ): Promise<JournalPageWriteResult> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(journalId)) {
      throw new Error(`Invalid journalId format: ${journalId}`);
    }
    if (!FOUNDRY_ID_PATTERN.test(pageId)) {
      throw new Error(`Invalid pageId format: ${pageId}`);
    }
    if (patch.name === undefined && patch.content === undefined) {
      throw new Error('updateJournalPage requires a name or content to change');
    }
    if (patch.name !== undefined && (typeof patch.name !== 'string' || !patch.name)) {
      throw new Error('name must be a non-empty string');
    }
    if (patch.content !== undefined && typeof patch.content !== 'string') {
      throw new Error('content must be a string');
    }
    if (patch.content !== undefined && !patch.expectedVersion) {
      throw new RefusedError(
        'Replacing a page body requires expectedVersion: read the page with get_journal raw: true first',
      );
    }

    return this.writeJournalPage(journalId, pageId, {
      mode: 'replace',
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.content !== undefined ? { content: patch.content } : {}),
      ...(patch.expectedVersion ? { expectedVersion: patch.expectedVersion } : {}),
    });
  }

  /**
   * Appends HTML to the end of a journal page's body.
   *
   * The body is read back from the server first ({@link fetchJournalEntry}),
   * never taken from the cache, so text written since the last sync is kept.
   * `expectedVersion` is optional here; when given, the append is refused if
   * the page changed since that version was read.
   *
   * @param journalId - 16-char alphanumeric JournalEntry document id
   * @param pageId - 16-char alphanumeric JournalEntryPage document id
   * @param html - HTML fragment to add after the existing content
   * @param expectedVersion - optional version token the caller last read
   */
  async appendJournalPage(
    journalId: string,
    pageId: string,
    html: string,
    expectedVersion?: string,
  ): Promise<JournalPageWriteResult> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(journalId)) {
      throw new Error(`Invalid journalId format: ${journalId}`);
    }
    if (!FOUNDRY_ID_PATTERN.test(pageId)) {
      throw new Error(`Invalid pageId format: ${pageId}`);
    }
    if (!html || typeof html !== 'string') {
      throw new Error('html is required and must be a non-empty string');
    }
    return this.writeJournalPage(journalId, pageId, {
      mode: 'append',
      content: html,
      ...(expectedVersion ? { expectedVersion } : {}),
    });
  }

  /**
   * The safe page write behind {@link updateJournalPage} and
   * {@link appendJournalPage}. Runs inside the tool call, so inside the write
   * queue:
   *
   * 1. Reads the entry back from the server and checks `expectedVersion`
   *    against the fresh body (refused, nothing written, on a mismatch).
   * 2. Saves the fresh body to the local history — a failure aborts the write.
   * 3. Writes, collecting any foreign change to the page that lands between
   *    the read-back and the server's acknowledgement: the server applied it
   *    first, so this write overwrote it. Each one is copied and reported.
   * 4. Watches the page for an overwrite of what this write added.
   */
  private async writeJournalPage(
    journalId: string,
    pageId: string,
    change: {
      mode: 'replace' | 'append';
      name?: string;
      content?: string;
      expectedVersion?: string;
    },
  ): Promise<JournalPageWriteResult> {
    const cachedContent = this.getJournal(journalId)?.pages?.find((p) => p._id === pageId)?.text
      ?.content;
    const journal = await this.fetchJournalEntry(journalId);
    if (!journal) {
      throw new Error(`Journal not found: ${journalId}`);
    }
    const page = journal.pages?.find((p) => p._id === pageId);
    if (!page) {
      throw new Error(`Journal page not found: ${pageId} in journal ${journalId}`);
    }
    const before = page.text?.content ?? '';
    const currentVersion = journalVersion(before);
    if (change.expectedVersion && change.expectedVersion !== currentVersion) {
      throw new RefusedError(
        `Page "${page.name}" (${pageId}) has changed since it was read: expected version ` +
          `${change.expectedVersion}, current version ${currentVersion}. Nothing was written. ` +
          'Read it again with get_journal raw: true, then rewrite it from the current version.',
      );
    }

    const notices: string[] = [];
    if (change.mode === 'append' && cachedContent !== undefined && cachedContent !== before) {
      notices.push(
        'The page had changed since the last sync; the text was appended to its current version.',
      );
    }
    if (this.journalWatch.hasRecentAutosave(journalId, pageId)) {
      notices.push(
        `⚠️ A FoundryVTT editor autosaved this page in the last ${RECENT_AUTOSAVE_MS / 60000} minutes: ` +
          'it may still be open in an editor, whose autosave can overwrite this write if text was ' +
          'typed in it. Closing that editor is safer. FoundryVTT does not report when an editor ' +
          'closes, so this notice can persist for a few minutes after it was closed.',
      );
    }

    const connectorName = this.connectorAccountName();
    let historyPath: string;
    try {
      historyPath = this.journalHistory.save({
        journalId,
        pageId,
        journalName: journal.name,
        pageName: page.name,
        reason: change.mode === 'append' ? 'before-append' : 'before-replace',
        content: before,
        overwrittenBy: connectorName,
        connectorAccount: connectorName,
      });
    } catch (error) {
      throw new Error(
        `Could not save a local copy of the page before writing it ` +
          `(${error instanceof Error ? error.message : String(error)}). Nothing was written.`,
      );
    }

    const update: Record<string, unknown> = { _id: pageId };
    if (change.name !== undefined) {
      update.name = change.name;
    }
    const newContent =
      change.content === undefined
        ? undefined
        : change.mode === 'append'
          ? `${before}${change.content}`
          : change.content;
    if (newContent !== undefined) {
      update['text.content'] = newContent;
    }

    // Only a body write can overwrite someone's body change: a rename leaves
    // text.content alone, so it opens no race window.
    if (newContent !== undefined) {
      this.journalWatch.beginWrite(journalId, pageId);
    }
    let result: unknown[];
    let raced: ForeignChange[] = [];
    try {
      result = await this.modifyDocument('JournalEntryPage', 'update', {
        updates: [update],
        parentUuid: `JournalEntry.${journalId}`,
        diff: true,
      });
    } finally {
      if (newContent !== undefined) {
        raced = this.journalWatch.endWrite(journalId, pageId);
      }
    }

    // The acknowledgement carries the body as the server cleaned and stored
    // it, or no `text` at all when the stored body did not change — then the
    // cache (the read-back plus any broadcast since) holds the current body.
    const ack = isRecord(result[0]) ? result[0] : {};
    const ackText = isRecord(ack.text) ? ack.text : undefined;
    const stored =
      typeof ackText?.content === 'string'
        ? ackText.content
        : (this.getJournal(journalId)?.pages?.find((p) => p._id === pageId)?.text?.content ??
          before);
    const pageName = change.name ?? page.name;

    logger.info('Journal page written', {
      journalId,
      pageId,
      mode: change.mode,
      before: currentVersion,
      after: journalVersion(stored),
      historyPath,
    });

    for (const foreign of raced) {
      // Nothing of theirs was lost when they had saved exactly what we wrote.
      if (foreign.content === undefined || foreign.content === stored) {
        continue;
      }
      this.reportJournalConflict({
        journalId,
        pageId,
        journalName: journal.name,
        pageName,
        reason: OVERWRITTEN_BY_CONNECTOR,
        savedBy: foreign.source.kind === 'autosave' ? null : this.userName(foreign.source.userId),
        copy: foreign.content,
        overwrittenBy: this.connectorAccountName(),
        versionBy:
          foreign.source.kind === 'autosave'
            ? EDITOR_AUTOSAVE_USER
            : this.userName(foreign.source.userId),
        detail:
          'their change reached the server while the connector was writing the page and was overwritten',
      });
    }

    if (newContent !== undefined) {
      this.journalWatch.watch({
        journalId,
        pageId,
        journalName: journal.name,
        pageName,
        after: stored,
        contribution: journalContribution({
          before,
          after: stored,
          ...(change.mode === 'append' ? { fragment: change.content } : {}),
        }),
      });
    }

    const cached = this.getJournal(journalId)?.pages?.find((p) => p._id === pageId);
    return {
      journalName: journal.name,
      page: cached ?? { ...page, name: pageName },
      version: journalVersion(stored),
      notices,
      historyPath,
    };
  }

  /**
   * Adds a text page to an existing journal entry, after its last page.
   *
   * Uses the same text-page shape as {@link createJournalEntry}. The `sort`
   * is one {@link SORT_INTEGER_DENSITY} step past the highest page sort of the
   * entry as read back from the server ({@link fetchJournalEntry}), so a page
   * added elsewhere since the last sync is not sorted over.
   *
   * @param journalId - 16-char alphanumeric JournalEntry document id
   * @param page - page title and HTML content
   * @returns the newly created page document
   */
  async addJournalPage(
    journalId: string,
    page: JournalPageCreateSource,
  ): Promise<WorldJournalPage> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(journalId)) {
      throw new Error(`Invalid journalId format: ${journalId}`);
    }
    if (!page?.name || typeof page.name !== 'string') {
      throw new Error('name is required and must be a string');
    }
    if (typeof page.content !== 'string') {
      throw new Error('content is required and must be a string');
    }
    const journal = await this.fetchJournalEntry(journalId);
    if (!journal) {
      throw new Error(`Journal not found: ${journalId}`);
    }

    const lastSort = Math.max(0, ...(journal.pages ?? []).map((p) => p.sort ?? 0));
    const result = await this.modifyDocument('JournalEntryPage', 'create', {
      data: [
        {
          name: page.name,
          type: 'text',
          text: { content: page.content, format: 1 },
          sort: lastSort + SORT_INTEGER_DENSITY,
        },
      ],
      parentUuid: `JournalEntry.${journalId}`,
    });
    return result[0] as WorldJournalPage;
  }

  /**
   * Renames, refiles, and/or changes the visibility of a journal entry.
   *
   * `JournalEntry` is top-level, so the update carries no `parentUuid`.
   * `visibility` sets only `ownership.default` (via {@link VISIBILITY_LEVELS},
   * as in {@link createJournalEntry}); the recursive merge keeps any per-user
   * ownership entries already on the document.
   *
   * @param journalId - 16-char alphanumeric JournalEntry document id
   * @param patch - new name, folder id and/or visibility; at least one required
   * @returns the updated journal entry data
   */
  async updateJournalEntry(journalId: string, patch: JournalEntryUpdate): Promise<WorldJournal> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(journalId)) {
      throw new Error(`Invalid journalId format: ${journalId}`);
    }
    const { name, folder, visibility } = patch;
    if (name === undefined && folder === undefined && visibility === undefined) {
      throw new Error('updateJournalEntry requires a name, folder or visibility to change');
    }
    if (name !== undefined && (typeof name !== 'string' || !name)) {
      throw new Error('name must be a non-empty string');
    }
    if (folder !== undefined && !FOUNDRY_ID_PATTERN.test(folder)) {
      throw new Error(`Invalid folder format: ${folder}`);
    }
    if (visibility !== undefined && !(visibility in VISIBILITY_LEVELS)) {
      throw new Error(
        `Invalid visibility: ${visibility}. Expected one of: ${Object.keys(VISIBILITY_LEVELS).join(', ')}`,
      );
    }

    const update: Record<string, unknown> = { _id: journalId };
    if (name !== undefined) {
      update.name = name;
    }
    if (folder !== undefined) {
      update.folder = folder;
    }
    if (visibility !== undefined) {
      update.ownership = { default: VISIBILITY_LEVELS[visibility] };
    }
    const result = await this.modifyDocument('JournalEntry', 'update', {
      updates: [update],
      diff: true,
      recursive: true,
    });
    return result[0] as WorldJournal;
  }

  // ==========================================================================
  // Chat mutation methods (WRITE — Socket.IO modifyDocument)
  // ==========================================================================

  /**
   * Posts a message to the FoundryVTT chat log.
   *
   * `ChatMessage` is a top-level document, so the create carries no
   * `parentUuid` (mirrors {@link createJournalEntry}). `style` matches
   * FoundryVTT's `CONST.CHAT_MESSAGE_STYLES` (0 OTHER, 1 OOC, 2 IC, 3 EMOTE),
   * confirmed against a live v12 world's raw message documents.
   *
   * @param content - message body (HTML or plain text)
   * @param options - optional display alias, whisper target user ids, and style
   * @returns the newly created chat message document
   */
  async sendChatMessage(
    content: string,
    options: { speaker?: string; whisperTo?: string[]; style?: 'ooc' | 'ic' | 'emote' } = {},
  ): Promise<WorldMessage> {
    this.assertWriteable();
    if (!content || typeof content !== 'string') {
      throw new Error('content is required and must be a string');
    }
    const STYLE_CODES: Record<'ooc' | 'ic' | 'emote', number> = { ooc: 1, ic: 2, emote: 3 };
    const data: Record<string, unknown> = {
      content,
      style: options.style ? STYLE_CODES[options.style] : 0,
    };
    // `author` has no server-side default (unlike `ownership`/`_stats` on
    // other document types) and is rejected as undefined without it; the
    // authenticated user's id rides along on every WorldData snapshot.
    if (this.worldData?.userId) {
      data.author = this.worldData.userId;
    }
    if (options.speaker) {
      data.speaker = { alias: options.speaker };
    }
    if (options.whisperTo && options.whisperTo.length > 0) {
      for (const userId of options.whisperTo) {
        if (!FOUNDRY_ID_PATTERN.test(userId)) {
          throw new Error(`Invalid whisper target user id format: ${userId}`);
        }
      }
      data.whisper = options.whisperTo;
    }
    const result = await this.modifyDocument('ChatMessage', 'create', { data: [data] });
    return result[0] as WorldMessage;
  }

  /**
   * Whispers a detected journal overwrite to the world's Gamemaster users,
   * leaving out the connector's own accounts.
   *
   * French when the server's default language (`options.language` of the
   * world snapshot) is French, English otherwise — `core.language` is a
   * per-browser setting the server never sees.
   *
   * @returns the whispered user ids (none when there is no GM to tell)
   */
  async whisperJournalConflict(conflict: JournalConflict): Promise<string[]> {
    const connectorIds = this.connectorUserIds();
    const gms = (this.worldData?.users ?? [])
      .filter((user) => user.role === USER_ROLES.gamemaster && !connectorIds.has(user._id))
      .map((user) => user._id);
    if (gms.length === 0) {
      return [];
    }
    const options = isRecord(this.worldData?.options) ? this.worldData.options : {};
    const language = typeof options.language === 'string' ? options.language : '';
    await this.sendChatMessage(journalConflictMessage(conflict, language.startsWith('fr')), {
      whisperTo: gms,
      speaker: JOURNAL_CONFLICT_SPEAKER,
    });
    return gms;
  }

  // ==========================================================================
  // Scene mutation methods (WRITE — Socket.IO modifyDocument)
  // ==========================================================================

  /**
   * Activates a scene, switching every connected client's canvas to it.
   *
   * FoundryVTT's server-side `Scene` document enforces "only one active
   * scene" on its own `_onUpdateDocuments` hook, deactivating any other
   * active scene as a side effect of this single update — no second write
   * is needed here.
   *
   * @param sceneId - 16-char alphanumeric Scene document id to activate
   * @returns the updated scene document
   */
  async switchScene(sceneId: string): Promise<unknown> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    // Not pre-checked against the cached worldData - Foundry itself is the
    // source of truth for whether sceneId exists and rejects a truly
    // missing id; a local check would only risk rejecting something valid,
    // e.g. a scene another client just created that a broadcast hasn't
    // reached this connection yet.
    const result = await this.modifyDocument('Scene', 'update', {
      updates: [{ _id: sceneId, active: true }],
      diff: true,
      recursive: true,
    });
    return result[0];
  }

  // ==========================================================================
  // Token creation (WRITE — Socket.IO modifyDocument)
  // ==========================================================================

  /**
   * Places a new token for an existing actor onto a scene.
   *
   * `Token` is an embedded document of `Scene` (mirrors {@link moveToken}),
   * so the create carries `parentUuid: "Scene.<sceneId>"`. Base display
   * fields (texture, size, vision) are seeded from the actor's
   * `prototypeToken`, then overridden by any explicit `name`/`hidden` argument.
   *
   * @param sceneId - 16-char alphanumeric Scene document id to place the token on
   * @param actorId - 16-char alphanumeric Actor document id the token represents
   * @param x - target x pixel coordinate (finite number)
   * @param y - target y pixel coordinate (finite number)
   * @param options - optional display name override and hidden flag
   * @returns the newly created token document
   */
  async spawnToken(
    sceneId: string,
    actorId: string,
    x: number,
    y: number,
    options: { name?: string; hidden?: boolean } = {},
  ): Promise<unknown> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    if (!FOUNDRY_ID_PATTERN.test(actorId)) {
      throw new Error(`Invalid actorId format: ${actorId}`);
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`Invalid coordinates: (${x}, ${y}) — x and y must be finite numbers`);
    }
    const actor = this.worldData?.actors.find((a) => a._id === actorId);
    if (!actor) {
      throw new Error(`Actor not found: ${actorId}`);
    }
    // sceneId is not pre-checked against the cached worldData, for the same
    // reason as switchScene above: Foundry itself validates it and rejects
    // a truly missing id.
    const proto: Record<string, unknown> = isRecord(actor.prototypeToken)
      ? { ...actor.prototypeToken }
      : {};
    delete proto._id;
    const tokenData: Record<string, unknown> = {
      ...proto,
      actorId,
      x,
      y,
      name: options.name ?? actor.name,
    };
    if (options.hidden !== undefined) {
      tokenData.hidden = options.hidden;
    }
    const result = await this.modifyDocument('Token', 'create', {
      data: [tokenData],
      parentUuid: `Scene.${sceneId}`,
    });
    return result[0];
  }

  /**
   * Removes a token from a scene.
   *
   * `Token` is an embedded document of `Scene` (mirrors {@link spawnToken}),
   * so the delete carries `parentUuid: "Scene.<sceneId>"`. Does not touch the
   * underlying Actor document — only the placed token is removed.
   *
   * @param sceneId - 16-char alphanumeric Scene document id the token is on
   * @param tokenId - 16-char alphanumeric Token document id to remove
   */
  async deleteToken(sceneId: string, tokenId: string): Promise<void> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    if (!FOUNDRY_ID_PATTERN.test(tokenId)) {
      throw new Error(`Invalid tokenId format: ${tokenId}`);
    }
    await this.modifyDocument('Token', 'delete', {
      ids: [tokenId],
      parentUuid: `Scene.${sceneId}`,
    });
  }

  /**
   * Permanently deletes a top-level Actor document (mirrors {@link createWorldActor}).
   *
   * @param actorId - 16-char alphanumeric Actor document id to delete
   */
  async deleteWorldActor(actorId: string): Promise<void> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(actorId)) {
      throw new Error(`Invalid actorId format: ${actorId}`);
    }
    await this.modifyDocument('Actor', 'delete', { ids: [actorId] });
  }

  /**
   * Permanently deletes a Scene document (mirrors {@link switchScene}).
   *
   * @param sceneId - 16-char alphanumeric Scene document id to delete
   */
  async deleteScene(sceneId: string): Promise<void> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    await this.modifyDocument('Scene', 'delete', { ids: [sceneId] });
  }

  /**
   * Updates document ownership permissions for users.
   *
   * @param documentType - collection the document lives in
   * @param documentId - 16-char alphanumeric document id
   * @param entries - mapping of user IDs (or "default") to ownership levels
   */
  async setDocumentOwnership(
    documentType: 'Actor' | 'Item' | 'Scene' | 'JournalEntry' | 'RollTable' | 'Macro',
    documentId: string,
    entries: Array<{ target: string; level: keyof typeof OWNERSHIP_LEVELS }>,
  ): Promise<unknown> {
    this.assertWriteable();
    const VALID_DOC_TYPES = new Set([
      'Actor',
      'Item',
      'Scene',
      'JournalEntry',
      'RollTable',
      'Macro',
    ]);
    if (!VALID_DOC_TYPES.has(documentType)) {
      throw new Error(
        `Invalid documentType "${documentType}": expected one of ${Array.from(VALID_DOC_TYPES).join(', ')}`,
      );
    }
    if (!FOUNDRY_ID_PATTERN.test(documentId)) {
      throw new Error(`Invalid documentId format: ${documentId}`);
    }
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error('entries is required and must contain at least one ownership mapping');
    }

    const ownership: Record<string, number> = {};
    for (const entry of entries) {
      if (entry.target !== 'default' && !FOUNDRY_ID_PATTERN.test(entry.target)) {
        throw new Error(
          `Invalid ownership target "${entry.target}": must be a 16-char user id or "default"`,
        );
      }
      const level = OWNERSHIP_LEVELS[entry.level];
      if (level === undefined) {
        throw new Error(
          `Invalid ownership level "${entry.level}": expected one of ${Object.keys(OWNERSHIP_LEVELS).join(', ')}`,
        );
      }
      ownership[entry.target] = level;
    }

    const result = await this.modifyDocument(documentType, 'update', {
      updates: [{ _id: documentId, ownership }],
      diff: true,
      recursive: true,
    });
    return result[0];
  }

  /**
   * Permanently deletes a JournalEntry document (mirrors {@link createJournalEntry}).
   *
   * @param journalId - 16-char alphanumeric JournalEntry document id to delete
   */
  async deleteJournalEntry(journalId: string): Promise<void> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(journalId)) {
      throw new Error(`Invalid journalId format: ${journalId}`);
    }
    await this.modifyDocument('JournalEntry', 'delete', { ids: [journalId] });
  }

  // ==========================================================================
  // Roll tables (read + local weighted draw)
  // ==========================================================================

  /**
   * Returns the world's RollTable documents (raw — no dedicated WorldRollTable
   * type; shape varies by table but always carries `name`, `formula`, and
   * `results` with a `range` per entry).
   */
  getRollTables(): Array<Record<string, unknown>> {
    return this.worldData?.tables ?? [];
  }

  /**
   * Draws a result from a RollTable by id.
   *
   * Rolls the table's own `formula` (falling back to a uniform 1..max(range)
   * draw when the table has none), then returns the result whose `range`
   * contains the roll. This is a local, read-only draw: unlike FoundryVTT's
   * own `RollTable#draw`, it does not mark the result `drawn` or respect a
   * "no duplicates" replacement setting — repeat draws can repeat a result.
   *
   * @param tableId - 16-char alphanumeric RollTable document id
   * @returns the table name, the numeric roll, and the matched result (or
   *   null if no result's range covers the roll — an incompletely configured table)
   */
  rollOnTable(tableId: string): {
    table: string;
    roll: number;
    result: Record<string, unknown> | null;
  } {
    if (!FOUNDRY_ID_PATTERN.test(tableId)) {
      throw new Error(`Invalid tableId format: ${tableId}`);
    }
    const table = this.getRollTables().find((t) => t._id === tableId);
    if (!table) {
      throw new Error(`Roll table not found: ${tableId}`);
    }
    const results = Array.isArray(table.results)
      ? (table.results as Array<Record<string, unknown>>)
      : [];
    if (results.length === 0) {
      throw new Error(`Roll table has no results: ${tableId}`);
    }
    const formula = typeof table.formula === 'string' ? table.formula : '';
    let roll: number;
    if (formula) {
      roll = evaluateDiceFormula(formula).total;
    } else {
      const maxRange = Math.max(
        ...results.map((r) => (Array.isArray(r.range) ? Number(r.range[1]) : 0)),
      );
      roll = Math.floor(Math.random() * Math.max(maxRange, 1)) + 1;
    }
    const result =
      results.find((r) => {
        if (!Array.isArray(r.range)) {
          return false;
        }
        const [min, max] = r.range;
        return roll >= Number(min) && roll <= Number(max);
      }) ?? null;
    return { table: typeof table.name === 'string' ? table.name : tableId, roll, result };
  }

  // ==========================================================================
  // RollTable mutation methods (WRITE — Socket.IO modifyDocument)
  // ==========================================================================

  async createRollTable(
    name: string,
    results: Array<{ text: string; weight?: number; range?: [number, number] }>,
    options: {
      description?: string;
      formula?: string;
      replacement?: boolean;
      displayRoll?: boolean;
      folder?: string;
    } = {},
  ): Promise<unknown> {
    this.assertWriteable();
    if (!name || typeof name !== 'string') {
      throw new Error('name is required and must be a string');
    }
    if (!Array.isArray(results) || results.length === 0) {
      throw new Error('results is required and must be a non-empty array');
    }
    if (options.folder !== undefined && !FOUNDRY_ID_PATTERN.test(options.folder)) {
      throw new Error(`Invalid folder format: ${options.folder}`);
    }

    const hasRange = results.some((r) => r.range !== undefined);
    const allHaveRange = results.every((r) => r.range !== undefined);
    if (hasRange && !allHaveRange) {
      throw new Error(
        'Provide range on every result or on none — mixing explicit and auto-assigned ranges produces gaps',
      );
    }

    for (const [i, r] of results.entries()) {
      if (!r.text || typeof r.text !== 'string') {
        throw new Error(`results[${i}].text is required and must be a string`);
      }
      if (r.weight !== undefined && (!Number.isInteger(r.weight) || r.weight <= 0)) {
        throw new Error(`results[${i}].weight must be a positive integer`);
      }
      if (allHaveRange) {
        if (
          !Array.isArray(r.range) ||
          r.range.length !== 2 ||
          !Number.isInteger(r.range[0]) ||
          !Number.isInteger(r.range[1]) ||
          (r.range[1] as number) < (r.range[0] as number)
        ) {
          throw new Error(`results[${i}].range must be a length-2 array of ascending integers`);
        }
      }
    }

    const formula = options.formula ?? (allHaveRange ? '' : `1d${results.length}`);
    const tableData: Record<string, unknown> = {
      name,
      formula,
      replacement: options.replacement ?? true,
      displayRoll: options.displayRoll ?? true,
    };
    if (options.description) {
      tableData.description = options.description;
    }
    if (options.folder) {
      tableData.folder = options.folder;
    }

    const created = await this.modifyDocument('RollTable', 'create', { data: [tableData] });
    const tableId = (created[0] as { _id?: string })?._id;
    if (tableId) {
      const resultDocs = results.map((r, i) => ({
        type: 'text',
        text: r.text,
        weight: r.weight ?? 1,
        range: r.range ?? [i + 1, i + 1],
      }));
      await this.modifyDocument('TableResult', 'create', {
        data: resultDocs,
        parentUuid: `RollTable.${tableId}`,
      });
    }
    return created[0];
  }

  async deleteRollTable(tableId: string): Promise<void> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(tableId)) {
      throw new Error(`Invalid tableId format: ${tableId}`);
    }
    await this.modifyDocument('RollTable', 'delete', { ids: [tableId] });
  }

  // ==========================================================================
  // Folder methods
  // ==========================================================================

  listFolders(options: { type?: string } = {}): WorldFolderEntry[] {
    const folders = this.worldData?.folders ?? [];
    let filtered = folders;
    if (options.type) {
      const q = options.type.toLowerCase();
      filtered = filtered.filter((f) => typeof f.type === 'string' && f.type.toLowerCase() === q);
    }
    return filtered.map((f) => ({
      id: typeof f._id === 'string' ? f._id : '',
      name: typeof f.name === 'string' ? f.name : '',
      type: typeof f.type === 'string' ? f.type : '',
      parent: typeof f.folder === 'string' ? f.folder : null,
      color: typeof f.color === 'string' ? f.color : null,
    }));
  }

  async createFolder(
    name: string,
    type: string,
    options: { parent?: string; color?: string; sorting?: 'a' | 'm' } = {},
  ): Promise<unknown> {
    this.assertWriteable();
    if (!name || typeof name !== 'string') {
      throw new Error('name is required and must be a string');
    }
    if (!type || typeof type !== 'string') {
      throw new Error('type is required and must be a string');
    }
    if (!FOLDER_DOCUMENT_TYPES.includes(type as (typeof FOLDER_DOCUMENT_TYPES)[number])) {
      throw new Error(
        `Invalid folder type: "${type}". Valid types are: ${FOLDER_DOCUMENT_TYPES.join(', ')}`,
      );
    }
    if (options.parent) {
      if (!FOUNDRY_ID_PATTERN.test(options.parent)) {
        throw new Error(`Invalid parent folder id format: ${options.parent}`);
      }
      const parentExists = this.worldData?.folders.some((f) => f._id === options.parent);
      if (!parentExists) {
        throw new Error(`Folder not found: ${options.parent}`);
      }
    }
    if (options.color && !HEX_COLOR_PATTERN.test(options.color)) {
      throw new Error(`Invalid color format: ${options.color} — must be a 6-digit hex color`);
    }

    const data: Record<string, unknown> = {
      name,
      type,
      sorting: options.sorting ?? 'a',
    };
    if (options.parent) {
      data.folder = options.parent;
    }
    if (options.color) {
      data.color = options.color;
    }

    const result = await this.modifyDocument('Folder', 'create', { data: [data] });
    return result[0];
  }

  // ==========================================================================
  // Macro methods
  // ==========================================================================

  listMacros(): WorldMacroEntry[] {
    const macros = this.worldData?.macros ?? [];
    return macros.map((m) => {
      const cmd = typeof m.command === 'string' ? m.command : '';
      const preview = cmd.slice(0, 200).replace(/\r?\n/g, ' ');
      return {
        id: typeof m._id === 'string' ? m._id : '',
        name: typeof m.name === 'string' ? m.name : '',
        type: typeof m.type === 'string' ? m.type : 'chat',
        scope: typeof m.scope === 'string' ? m.scope : 'global',
        folder: typeof m.folder === 'string' ? m.folder : null,
        commandPreview: preview,
      };
    });
  }

  async createMacro(
    name: string,
    type: 'script' | 'chat',
    command: string,
    options: { img?: string; folder?: string; scope?: 'global' | 'actors' | 'actor' } = {},
  ): Promise<unknown> {
    this.assertWriteable();
    if (!name || typeof name !== 'string') {
      throw new Error('name is required and must be a string');
    }
    if (type !== 'script' && type !== 'chat') {
      throw new Error('Invalid macro type: must be "script" or "chat"');
    }
    if (typeof command !== 'string') {
      throw new Error('command is required and must be a string');
    }
    if (options.folder !== undefined && !FOUNDRY_ID_PATTERN.test(options.folder)) {
      throw new Error(`Invalid folder format: ${options.folder}`);
    }

    const data: Record<string, unknown> = {
      name,
      type,
      command,
      author: this.worldData?.userId,
      scope: options.scope ?? 'global',
    };
    if (options.img) {
      data.img = options.img;
    }
    if (options.folder) {
      data.folder = options.folder;
    }

    const result = await this.modifyDocument('Macro', 'create', { data: [data] });
    return result[0];
  }

  async deleteMacro(macroId: string): Promise<void> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(macroId)) {
      throw new Error(`Invalid macroId format: ${macroId}`);
    }
    await this.modifyDocument('Macro', 'delete', { ids: [macroId] });
  }

  // ==========================================================================
  // Playlist methods
  // ==========================================================================

  listPlaylists(): WorldPlaylistEntry[] {
    const playlists = this.worldData?.playlists ?? [];
    return playlists.map((p) => {
      const sounds = Array.isArray(p.sounds) ? (p.sounds as Array<Record<string, unknown>>) : [];
      return {
        id: typeof p._id === 'string' ? p._id : '',
        name: typeof p.name === 'string' ? p.name : '',
        playing: p.playing === true,
        mode: typeof p.mode === 'number' ? p.mode : 0,
        channel: typeof p.channel === 'string' ? p.channel : 'music',
        soundCount: sounds.length,
        sounds: sounds.map((s) => ({
          id: typeof s._id === 'string' ? s._id : '',
          name: typeof s.name === 'string' ? s.name : '',
          path: typeof s.path === 'string' ? s.path : '',
          playing: s.playing === true,
          volume: typeof s.volume === 'number' ? s.volume : 0.5,
        })),
      };
    });
  }

  async createPlaylist(
    name: string,
    options: {
      description?: string;
      mode?: -1 | 0 | 1 | 2;
      channel?: 'music' | 'environment' | 'interface';
      fade?: number;
      folder?: string;
      sounds?: Array<{ name: string; path: string; volume?: number; repeat?: boolean }>;
    } = {},
  ): Promise<unknown> {
    this.assertWriteable();
    if (!name || typeof name !== 'string') {
      throw new Error('name is required and must be a string');
    }
    if (options.mode !== undefined && ![-1, 0, 1, 2].includes(options.mode)) {
      throw new Error(
        'Invalid playlist mode: must be -1 (disabled), 0 (sequential), 1 (shuffle), or 2 (simultaneous)',
      );
    }
    if (options.channel && !['music', 'environment', 'interface'].includes(options.channel)) {
      throw new Error('Invalid audio channel: must be "music", "environment", or "interface"');
    }
    if (options.folder !== undefined && !FOUNDRY_ID_PATTERN.test(options.folder)) {
      throw new Error(`Invalid folder format: ${options.folder}`);
    }

    const data: Record<string, unknown> = {
      name,
      mode: options.mode ?? 0,
      channel: options.channel ?? 'music',
    };
    if (options.description) {
      data.description = options.description;
    }
    if (options.fade !== undefined) {
      data.fade = options.fade;
    }
    if (options.folder) {
      data.folder = options.folder;
    }

    const created = await this.modifyDocument('Playlist', 'create', { data: [data] });
    const playlistId = (created[0] as { _id?: string })?._id;

    if (options.sounds && options.sounds.length > 0 && playlistId) {
      for (const [i, s] of options.sounds.entries()) {
        if (!s.name || typeof s.name !== 'string') {
          throw new Error(`sounds[${i}].name is required and must be a string`);
        }
        if (!s.path || typeof s.path !== 'string') {
          throw new Error(`sounds[${i}].path is required and must be a string`);
        }
      }
      const soundDocs = options.sounds.map((s) => ({
        name: s.name,
        path: s.path,
        volume: s.volume ?? 0.5,
        repeat: s.repeat ?? false,
      }));
      await this.modifyDocument('PlaylistSound', 'create', {
        data: soundDocs,
        parentUuid: `Playlist.${playlistId}`,
      });
    }
    return created[0];
  }

  async setPlaylistState(
    playlistId: string,
    playing: boolean,
    options: { soundId?: string } = {},
  ): Promise<unknown> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(playlistId)) {
      throw new Error(`Invalid playlistId format: ${playlistId}`);
    }
    if (options.soundId) {
      if (!FOUNDRY_ID_PATTERN.test(options.soundId)) {
        throw new Error(`Invalid soundId format: ${options.soundId}`);
      }
      const playlist = this.worldData?.playlists.find((p) => p._id === playlistId);
      const sounds = Array.isArray(playlist?.sounds)
        ? (playlist.sounds as Array<Record<string, unknown>>)
        : [];
      const soundExists = sounds.some((s) => s._id === options.soundId);
      if (!soundExists) {
        throw new Error(`Sound not found on playlist: ${options.soundId}`);
      }
      const result = await this.modifyDocument('PlaylistSound', 'update', {
        updates: [{ _id: options.soundId, playing }],
        parentUuid: `Playlist.${playlistId}`,
        diff: true,
      });
      return result[0];
    }

    const result = await this.modifyDocument('Playlist', 'update', {
      updates: [{ _id: playlistId, playing }],
      diff: true,
    });
    return result[0];
  }

  async deletePlaylist(playlistId: string): Promise<void> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(playlistId)) {
      throw new Error(`Invalid playlistId format: ${playlistId}`);
    }
    await this.modifyDocument('Playlist', 'delete', { ids: [playlistId] });
  }

  // ==========================================================================
  // World settings methods
  // ==========================================================================

  /**
   * Reads a world setting by key (e.g. "cyberpunk-red-core.customSetting").
   */
  getWorldSetting(key: string): {
    key: string;
    value: unknown;
    exists: boolean;
    raw: string | null;
  } {
    if (!key || typeof key !== 'string') {
      throw new Error('key is required and must be a string');
    }
    const settings = this.worldData?.settings ?? [];
    const setting = settings.find((s) => s.key === key);
    if (!setting) {
      return { key, value: undefined, exists: false, raw: null };
    }
    const raw = typeof setting.value === 'string' ? setting.value : JSON.stringify(setting.value);
    let parsed: unknown = raw;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = setting.value;
    }
    return { key, value: parsed, exists: true, raw };
  }

  /**
   * Sets a world setting by key (system or module settings only; core.* is refused).
   */
  async setWorldSetting(
    key: string,
    value: unknown,
  ): Promise<{ key: string; value: unknown; previous: unknown; created: boolean }> {
    this.assertWriteable();
    if (!key || typeof key !== 'string') {
      throw new Error('key is required and must be a string');
    }
    const parts = key.split('.');
    if (parts.length < 2 || parts.some((p) => p.length === 0)) {
      throw new Error(
        `Invalid setting key: "${key}" — must have format {scope}.{field} (e.g. "system-name.settingKey")`,
      );
    }
    const account = this.accountInfo();
    if (
      key === 'core.permissions' &&
      account?.role != null &&
      account.role < USER_ROLES.gamemaster
    ) {
      throw new RefusedError(
        `The connector's account "${account.name}" is ${roleLabel(account.role)}: only a ` +
          'Gamemaster may change core.permissions. Change it in FoundryVTT as a Gamemaster.',
      );
    }
    if (parts[0] === 'core') {
      throw new Error(
        'Refusing to write a core.* setting — those control the FoundryVTT client itself and a wrong value can break the world. Change core settings in the Foundry UI.',
      );
    }

    const existing = this.worldData?.settings.find((s) => s.key === key);
    let previous: unknown;
    if (existing) {
      const raw =
        typeof existing.value === 'string' ? existing.value : JSON.stringify(existing.value);
      try {
        previous = JSON.parse(raw);
      } catch {
        previous = existing.value;
      }
    }

    const serializedValue = JSON.stringify(value);

    if (existing?._id) {
      await this.modifyDocument('Setting', 'update', {
        updates: [{ _id: existing._id, value: serializedValue }],
        diff: true,
      });
      return { key, value, previous, created: false };
    }

    await this.modifyDocument('Setting', 'create', {
      data: [{ key, value: serializedValue }],
    });
    return { key, value, previous: undefined, created: true };
  }

  // ==========================================================================
  // Wall / door mutation methods (WRITE — Socket.IO modifyDocument)
  // ==========================================================================

  /**
   * Locates a wall (and the scene it lives on) in the cached worldData.
   * Mirrors {@link findToken}.
   */
  findWall(
    wallId: string,
    sceneId?: string,
  ): { scene: WorldScene; wall: Record<string, unknown> } | null {
    if (!this.worldData) {
      return null;
    }
    const scenes = sceneId
      ? this.worldData.scenes.filter((s) => s._id === sceneId)
      : this.worldData.scenes;
    for (const scene of scenes) {
      const wall = scene.walls?.find((w) => (w as { _id?: string })._id === wallId);
      if (wall) {
        return { scene, wall };
      }
    }
    return null;
  }

  /**
   * Sets a door's state. `Wall` is an embedded document of `Scene`, and `ds`
   * ("door state") is a plain field on it — 0 closed, 1 open, 2 locked — so
   * this is a standard `modifyDocument` update, the same as {@link moveToken}.
   * No canvas access is required; FoundryVTT's server enforces the field
   * only applies when the wall is actually a door (`wall.door !== 0`).
   *
   * @param sceneId - 16-char alphanumeric Scene document id the wall is on
   * @param wallId - 16-char alphanumeric Wall document id
   * @param state - 0 (closed), 1 (open), or 2 (locked)
   */
  async setDoorState(sceneId: string, wallId: string, state: 0 | 1 | 2): Promise<unknown> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    if (!FOUNDRY_ID_PATTERN.test(wallId)) {
      throw new Error(`Invalid wallId format: ${wallId}`);
    }
    if (state !== 0 && state !== 1 && state !== 2) {
      throw new Error(`Invalid door state: ${state}. Must be 0 (closed), 1 (open), or 2 (locked)`);
    }
    const result = await this.modifyDocument('Wall', 'update', {
      updates: [{ _id: wallId, ds: state }],
      parentUuid: `Scene.${sceneId}`,
      diff: true,
    });
    return result[0];
  }

  // ==========================================================================
  // Scene lighting mutation methods (WRITE — Socket.IO modifyDocument)
  // ==========================================================================

  /**
   * Sets a scene's ambient darkness level and/or global illumination fields.
   * All three are plain top-level fields on the `Scene` document (mirrors
   * {@link switchScene}) — no canvas access required.
   *
   * @param sceneId - 16-char alphanumeric Scene document id
   * @param options - at least one of darkness (0-1), globalLight, globalLightThreshold
   */
  async setSceneLighting(
    sceneId: string,
    options: { darkness?: number; globalLight?: boolean; globalLightThreshold?: number },
  ): Promise<unknown> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    if (
      options.darkness !== undefined &&
      (!Number.isFinite(options.darkness) || options.darkness < 0 || options.darkness > 1)
    ) {
      throw new Error(`Invalid darkness: ${options.darkness} (must be a number between 0 and 1)`);
    }
    const update: Record<string, unknown> = { _id: sceneId };
    if (options.darkness !== undefined) {
      update.darkness = options.darkness;
    }
    if (options.globalLight !== undefined) {
      update.globalLight = options.globalLight;
    }
    if (options.globalLightThreshold !== undefined) {
      update.globalLightThreshold = options.globalLightThreshold;
    }
    if (Object.keys(update).length === 1) {
      throw new Error('At least one of darkness, globalLight, globalLightThreshold is required');
    }
    const result = await this.modifyDocument('Scene', 'update', {
      updates: [update],
      diff: true,
      recursive: true,
    });
    return result[0];
  }

  /**
   * Updates a scene's weather effect (e.g. "rain", "snow", "leaves",
   * "rainStorm", "fog"), or clears it when passed `''`.
   *
   * @param sceneId - 16-char alphanumeric Scene document id
   * @param weather - weather effect key string, or empty string to clear
   */
  async setSceneWeather(sceneId: string, weather: string): Promise<unknown> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    if (typeof weather !== 'string') {
      throw new Error('weather is required and must be a string');
    }
    const result = await this.modifyDocument('Scene', 'update', {
      updates: [{ _id: sceneId, weather }],
      diff: true,
      recursive: true,
    });
    return result[0];
  }

  /**
   * Resets fog of war exploration for a scene via the socket resetFog event.
   *
   * @param sceneId - 16-char alphanumeric Scene document id
   */
  async resetFog(sceneId: string): Promise<void> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    this.socket?.emit('resetFog', sceneId);
  }

  // ==========================================================================
  // Wall-aware token pathfinding (WRITE — Socket.IO modifyDocument)
  //
  // Pure geometry over the cached `Scene.walls` array — no canvas, no PIXI.
  // The A* search and segment-intersection collision check are ported from
  // alexivenkov/foundry-api-bridge-module (MIT), GridPathfinder.ts +
  // DoorAwareCollision.ts, with the module's "ask the real canvas collision
  // backend first" step removed: headless, we have no canvas, so the ported
  // wall-segment check is the *only* collision source (see the module-scope
  // `path*` helpers below the class). That means this catches ordinary walls
  // and doors but not anything canvas-only would also enforce (terrain
  // height, drawings-as-obstacles, etc.) — a real map with only geometric
  // walls behaves the same; an unusual one may not.
  // ==========================================================================

  /**
   * Moves a token to (x, y), routing around impassable walls when the direct
   * line is blocked, and — unless `openDoors` is false — opening any closed,
   * non-locked doors the route needs to pass through along the way (each
   * open is its own `setDoorState` write, with a short delay so connected
   * clients see the door open before the token continues).
   *
   * @param sceneId - 16-char alphanumeric Scene document id the token is on
   * @param tokenId - 16-char alphanumeric Token document id to move
   * @param x - target x pixel coordinate
   * @param y - target y pixel coordinate
   * @param options - `openDoors` (default true)
   * @returns the waypoints taken, any doors opened, whether no route was
   *   found (`blocked`), and the final token document
   */
  async moveTokenPathfind(
    sceneId: string,
    tokenId: string,
    x: number,
    y: number,
    options: { openDoors?: boolean } = {},
  ): Promise<{
    path: Array<{ x: number; y: number }>;
    doorsOpened: string[];
    blocked: boolean;
    final: unknown;
  }> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    if (!FOUNDRY_ID_PATTERN.test(tokenId)) {
      throw new Error(`Invalid tokenId format: ${tokenId}`);
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`Invalid coordinates: (${x}, ${y}) — x and y must be finite numbers`);
    }
    const scene = this.worldData?.scenes.find((s) => s._id === sceneId);
    if (!scene) {
      throw new Error(`Scene not found: ${sceneId}`);
    }
    const token = scene.tokens?.find((t) => (t as { _id?: string })._id === tokenId) as
      | Record<string, unknown>
      | undefined;
    if (!token) {
      throw new Error(`Token not found: ${tokenId} on scene ${sceneId}`);
    }

    const gridSize = extractGridSize(scene);
    const startX = Number(token.x ?? 0);
    const startY = Number(token.y ?? 0);
    const tokenW = Number(token.width ?? 1) || 1;
    const tokenH = Number(token.height ?? 1) || 1;
    const openDoors = options.openDoors !== false;

    const wallInfos = extractWallInfos(scene);
    const openableDoors = wallInfos.filter((w) => w.door === 1 && w.ds === 0 && w.move !== 0);
    const impassableWalls = wallInfos.filter((w) => {
      if (w.move === 0) {
        return false;
      }
      if (w.door === 1 && w.ds === 0 && openDoors) {
        return false; // closed door we're willing to open — treat as passable
      }
      if (w.door === 1 && w.ds === 1) {
        return false; // already open
      }
      return true;
    });

    const directBlocked = isDirectPathBlocked(
      startX,
      startY,
      x,
      y,
      tokenW,
      tokenH,
      gridSize,
      impassableWalls,
    );

    let waypoints: Array<{ x: number; y: number }>;
    if (!directBlocked) {
      waypoints = [{ x, y }];
    } else {
      const pathResult = findGridTokenPath(
        startX,
        startY,
        x,
        y,
        gridSize,
        tokenW,
        tokenH,
        impassableWalls,
      );
      if (!pathResult || pathResult.path.length === 0) {
        return { path: [], doorsOpened: [], blocked: true, final: null };
      }
      // The A* search operates on grid cells, so pathResult.path's final
      // waypoint is the destination cell's top-left corner, not the exact
      // requested (x, y). Swap it in - the point is inside the same,
      // already-verified-reachable cell, so the token lands precisely
      // where asked instead of snapping to the nearest grid line.
      waypoints = [...pathResult.path.slice(0, -1), { x, y }];
    }

    const doorsOnPath = openDoors
      ? findDoorsOnPath(startX, startY, gridSize, waypoints, openableDoors)
      : [];

    const doorsOpened: string[] = [];
    let final: unknown = null;
    for (let i = 0; i < waypoints.length; i++) {
      const waypoint = waypoints[i];
      if (!waypoint) {
        continue;
      }
      for (const door of doorsOnPath.filter((d) => d.betweenIndex === i)) {
        await this.setDoorState(sceneId, door.wallId, 1);
        doorsOpened.push(door.wallId);
        await pathDelay(400);
      }
      const result = await this.modifyDocument('Token', 'update', {
        updates: [{ _id: tokenId, x: waypoint.x, y: waypoint.y }],
        parentUuid: `Scene.${sceneId}`,
        diff: true,
      });
      final = result[0];
    }

    return { path: waypoints, doorsOpened, blocked: false, final };
  }

  // ==========================================================================
  // Scene & tile creation (WRITE — Socket.IO modifyDocument)
  //
  // Lets a scene be assembled and decorated entirely from cached/local data
  // — no browser tab, no visual-placement guesswork. `createScene`/
  // `createTile` read real pixel dimensions off disk when FOUNDRY_DATA_PATH
  // is configured ({@link getImageSize}), and `findOpenCells` reuses the
  // same wall-segment geometry {@link moveTokenPathfind} uses so placement
  // can avoid walls without a screenshot.
  // ==========================================================================

  /**
   * Resolves a Data-relative asset path (e.g. "assets/cyberpunk/maps/v1/x.jpg")
   * against the configured `dataPath`, guarding against path traversal
   * outside the Data directory. Throws if `dataPath` is not configured —
   * every caller needs it for the same reason (reading a real file).
   */
  private resolveDataPath(relativeSrc: string): string {
    if (!this.config.dataPath) {
      throw new Error(
        'FOUNDRY_DATA_PATH is not configured — set it to the FoundryVTT Data directory ' +
          '(enables reading image dimensions from disk; only possible when this server runs ' +
          'on the same host as FoundryVTT).',
      );
    }
    const base = pathResolve(this.config.dataPath);
    const resolved = pathResolve(base, relativeSrc);
    if (resolved !== base && !resolved.startsWith(base + pathSep)) {
      throw new Error(`Path escapes the Data directory: ${relativeSrc}`);
    }
    return resolved;
  }

  /**
   * Reads an asset's real pixel dimensions from disk via {@link resolveDataPath}
   * + {@link getImageSize}, throwing a caller-actionable error rather than
   * silently falling back to a guess — a wrong width/height would otherwise
   * misalign the grid or tile silently.
   */
  private requireImageSize(relativeSrc: string): ImageSize {
    const absolutePath = this.resolveDataPath(relativeSrc);
    const size = getImageSize(absolutePath);
    if (!size) {
      throw new Error(
        `Could not read image dimensions for "${relativeSrc}" — pass width/height explicitly, ` +
          'or verify the file exists under FOUNDRY_DATA_PATH and is a PNG/JPEG/WebP.',
      );
    }
    return size;
  }

  /**
   * Creates a new Scene document from a background image already present
   * under FoundryVTT's `Data` directory. Width/height default to the
   * image's real pixel dimensions (read from disk via FOUNDRY_DATA_PATH)
   * when not given explicitly — the single biggest source of a misaligned
   * grid when scenes are built by hand.
   *
   * @param name - Scene display name
   * @param backgroundSrc - Data-relative path to the background image (e.g. "assets/cyberpunk/maps/v1/x.jpg")
   * @param options - grid size/type/distance/units, padding, explicit width/height, activate-on-create
   * @returns the newly created scene document
   */
  async createScene(
    name: string,
    backgroundSrc: string,
    options: {
      width?: number;
      height?: number;
      gridSize?: number;
      gridType?: number;
      gridDistance?: number;
      gridUnits?: string;
      padding?: number;
      backgroundColor?: string;
      activate?: boolean;
    } = {},
  ): Promise<unknown> {
    this.assertWriteable();
    if (!name || typeof name !== 'string') {
      throw new Error('name is required and must be a string');
    }
    if (!backgroundSrc || typeof backgroundSrc !== 'string') {
      throw new Error('backgroundSrc is required and must be a string');
    }

    const size =
      options.width !== undefined && options.height !== undefined
        ? { width: options.width, height: options.height }
        : this.requireImageSize(backgroundSrc);
    const width = options.width ?? size.width;
    const height = options.height ?? size.height;

    const data: Record<string, unknown> = {
      name,
      background: { src: backgroundSrc },
      width,
      height,
      padding: options.padding ?? 0.25,
      backgroundColor: options.backgroundColor ?? '#999999',
      grid: {
        type: options.gridType ?? 1,
        size: options.gridSize ?? 100,
        distance: options.gridDistance ?? 1,
        units: options.gridUnits ?? 'ft',
      },
    };

    const result = await this.modifyDocument('Scene', 'create', { data: [data] });
    const created = result[0] as { _id?: string } | undefined;
    if (options.activate && created?._id) {
      await this.switchScene(created._id);
    }
    return created;
  }

  /**
   * Places a decorative Tile on a scene from an image already present under
   * FoundryVTT's `Data` directory. Width/height default to the image's real
   * pixel dimensions when not given. Position is either explicit pixel
   * `x`/`y` (top-left corner) or a `gridCol`/`gridRow` cell (the tile is
   * centred in that cell).
   *
   * By default refuses to place a tile whose bounding box crosses a scene
   * wall (the same wall-segment geometry {@link moveTokenPathfind} uses) —
   * pass `allowWallOverlap: true` to place anyway (e.g. a wall-mounted prop
   * that is meant to straddle a wall).
   *
   * @param sceneId - 16-char alphanumeric Scene document id
   * @param src - Data-relative path to the tile image
   * @param options - position (x/y or gridCol/gridRow), size, rotation, elevation, hidden, allowWallOverlap
   * @returns the newly created tile document
   */
  async createTile(
    sceneId: string,
    src: string,
    options: {
      x?: number;
      y?: number;
      gridCol?: number;
      gridRow?: number;
      width?: number;
      height?: number;
      rotation?: number;
      elevation?: number;
      hidden?: boolean;
      allowWallOverlap?: boolean;
    } = {},
  ): Promise<unknown> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    if (!src || typeof src !== 'string') {
      throw new Error('src is required and must be a string');
    }
    const scene = this.worldData?.scenes.find((s) => s._id === sceneId);
    if (!scene) {
      throw new Error(`Scene not found: ${sceneId}`);
    }

    const size =
      options.width !== undefined && options.height !== undefined
        ? { width: options.width, height: options.height }
        : this.requireImageSize(src);
    const width = options.width ?? size.width;
    const height = options.height ?? size.height;

    let x: number;
    let y: number;
    if (options.x !== undefined && options.y !== undefined) {
      x = options.x;
      y = options.y;
    } else if (options.gridCol !== undefined && options.gridRow !== undefined) {
      const gridSize = extractGridSize(scene);
      x = options.gridCol * gridSize + gridSize / 2 - width / 2;
      y = options.gridRow * gridSize + gridSize / 2 - height / 2;
    } else {
      throw new Error('Either x/y or gridCol/gridRow is required to position the tile');
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`Invalid coordinates: (${x}, ${y}) — x and y must be finite numbers`);
    }

    if (!options.allowWallOverlap) {
      const rect: PathRect = { x, y, width, height };
      const blocking = extractWallInfos(scene).find((w) => {
        const [p1, p2] = pathWallSegment(w);
        return rectIntersectsSegment(rect, p1, p2);
      });
      if (blocking) {
        throw new Error(
          `Tile placement at (${x}, ${y}) size ${width}x${height} crosses wall ${blocking.id}. ` +
            'Pick an open cell (see find_open_cells), or pass allowWallOverlap: true to place anyway.',
        );
      }
    }

    const tileData: Record<string, unknown> = {
      texture: { src },
      x,
      y,
      width,
      height,
      rotation: options.rotation ?? 0,
      elevation: options.elevation ?? 0,
      hidden: options.hidden ?? false,
    };

    const result = await this.modifyDocument('Tile', 'create', {
      data: [tileData],
      parentUuid: `Scene.${sceneId}`,
    });
    return result[0];
  }

  /**
   * Removes a Tile from a scene (mirrors {@link deleteToken}).
   *
   * @param sceneId - 16-char alphanumeric Scene document id
   * @param tileId - 16-char alphanumeric Tile document id
   */
  async deleteTile(sceneId: string, tileId: string): Promise<void> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    if (!FOUNDRY_ID_PATTERN.test(tileId)) {
      throw new Error(`Invalid tileId format: ${tileId}`);
    }
    await this.modifyDocument('Tile', 'delete', {
      ids: [tileId],
      parentUuid: `Scene.${sceneId}`,
    });
  }

  /**
   * Lists the Tiles placed on a scene, read from the cached worldData
   * snapshot — no network round trip. Lets a caller check current
   * decoration state without a `capture_scene` screenshot.
   *
   * @param sceneId - 16-char alphanumeric Scene document id
   */
  listTiles(sceneId: string): Array<{
    id: string;
    src: string;
    x: number;
    y: number;
    width: number;
    height: number;
    rotation: number;
    hidden: boolean;
  }> {
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    const scene = this.worldData?.scenes.find((s) => s._id === sceneId);
    if (!scene) {
      throw new Error(`Scene not found: ${sceneId}`);
    }
    const tiles = Array.isArray(scene.tiles) ? scene.tiles : [];
    return tiles.map((t) => {
      const rec = t as Record<string, unknown>;
      const texture = isRecord(rec.texture) ? rec.texture : undefined;
      return {
        id: typeof rec._id === 'string' ? rec._id : '',
        src: texture && typeof texture.src === 'string' ? texture.src : '',
        x: typeof rec.x === 'number' ? rec.x : 0,
        y: typeof rec.y === 'number' ? rec.y : 0,
        width: typeof rec.width === 'number' ? rec.width : 0,
        height: typeof rec.height === 'number' ? rec.height : 0,
        rotation: typeof rec.rotation === 'number' ? rec.rotation : 0,
        hidden: rec.hidden === true,
      };
    });
  }

  /**
   * Scans a scene's grid for cells with no wall crossing them and no
   * existing tile/token already centred there — a placement candidate list
   * for `create_tile`/`spawn_token` that needs no screenshot to compute.
   * Restricted to the background image's own extent (`0..width`,
   * `0..height`); the scene's `padding` margin around it is never floor.
   *
   * @param sceneId - 16-char alphanumeric Scene document id
   * @param options - `limit` (default 50) caps how many open cells are returned
   */
  findOpenCells(
    sceneId: string,
    options: { limit?: number } = {},
  ): Array<{ col: number; row: number; x: number; y: number }> {
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    const scene = this.worldData?.scenes.find((s) => s._id === sceneId);
    if (!scene) {
      throw new Error(`Scene not found: ${sceneId}`);
    }
    const gridSize = extractGridSize(scene);
    const cols = Math.ceil(scene.width / gridSize);
    const rows = Math.ceil(scene.height / gridSize);
    const impassableWalls = extractWallInfos(scene).filter(
      (w) => w.move !== 0 && !(w.door === 1 && w.ds === 1),
    );

    const occupiedCenters: Array<{ x: number; y: number }> = [
      ...(Array.isArray(scene.tiles) ? scene.tiles : []),
      ...(Array.isArray(scene.tokens) ? scene.tokens : []),
    ].map((d) => {
      const rec = d as Record<string, unknown>;
      const w = typeof rec.width === 'number' ? rec.width : gridSize;
      const h = typeof rec.height === 'number' ? rec.height : gridSize;
      const px = typeof rec.x === 'number' ? rec.x : 0;
      const py = typeof rec.y === 'number' ? rec.y : 0;
      return { x: px + w / 2, y: py + h / 2 };
    });

    const limit = options.limit ?? 50;
    const open: Array<{ col: number; row: number; x: number; y: number }> = [];
    for (let row = 0; row < rows && open.length < limit; row++) {
      for (let col = 0; col < cols && open.length < limit; col++) {
        const rect: PathRect = {
          x: col * gridSize,
          y: row * gridSize,
          width: gridSize,
          height: gridSize,
        };
        const blockedByWall = impassableWalls.some((w) => {
          const [p1, p2] = pathWallSegment(w);
          return rectIntersectsSegment(rect, p1, p2);
        });
        if (blockedByWall) {
          continue;
        }
        const occupied = occupiedCenters.some(
          (o) =>
            o.x >= rect.x && o.x < rect.x + gridSize && o.y >= rect.y && o.y < rect.y + gridSize,
        );
        if (occupied) {
          continue;
        }
        open.push({ col, row, x: rect.x + gridSize / 2, y: rect.y + gridSize / 2 });
      }
    }
    return open;
  }

  /**
   * Lists image assets under a folder of FoundryVTT's `Data` directory —
   * map backgrounds, prop/token art, etc. — with real pixel dimensions and
   * any `[Tag, Tag]`-bracketed keyword tags parsed out of the filename (the
   * naming convention several battlemap packs use). Requires FOUNDRY_DATA_PATH.
   *
   * @param subdir - Data-relative folder to scan (default "assets")
   * @param options - `query` filters by filename/tag substring (case-insensitive); `limit` caps results (default 200)
   */
  listSceneAssets(
    subdir = 'assets',
    options: { query?: string; limit?: number; kind?: 'image' | 'audio' } = {},
  ): Array<{ path: string; name: string; tags: string[]; width: number; height: number }> {
    const dataPath = this.config.dataPath;
    const root = this.resolveDataPath(subdir);
    const limit = options.limit ?? 200;
    const query = options.query?.toLowerCase();
    const isAudio = options.kind === 'audio';
    const pattern = isAudio ? AUDIO_EXTENSION_PATTERN : IMAGE_EXTENSION_PATTERN;
    const results: Array<{
      path: string;
      name: string;
      tags: string[];
      width: number;
      height: number;
    }> = [];

    const walk = (dir: string): void => {
      if (results.length >= limit) {
        return;
      }
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= limit) {
          return;
        }
        const full = pathJoin(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!pattern.test(entry.name)) {
          continue;
        }
        const tagMatch = entry.name.match(/\[([^\]]+)\]/);
        const tags = tagMatch
          ? (tagMatch[1] as string)
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean)
          : [];
        const name = entry.name
          .replace(/\.[^.]+$/, '')
          .replace(/\s*\[[^\]]+\]\s*$/, '')
          .trim();
        if (query) {
          const haystack = `${entry.name} ${tags.join(' ')}`.toLowerCase();
          if (!haystack.includes(query)) {
            continue;
          }
        }
        const size = isAudio ? null : getImageSize(full);
        const relative = pathRelative(dataPath as string, full)
          .split(pathSep)
          .join('/');
        results.push({
          path: relative,
          name,
          tags,
          width: size?.width ?? 0,
          height: size?.height ?? 0,
        });
      }
    };
    walk(root);
    return results;
  }

  // ==========================================================================
  // Wall creation (WRITE — Socket.IO modifyDocument)
  //
  // Complements moveTokenPathfind/createTile's wall-awareness: lets a scene's
  // physical layout (rooms, doors, windows) be built without canvas
  // drag-drawing. Walls connect grid *vertices* (intersections), not cell
  // centres like tiles/tokens — placement takes fromCol/fromRow -> toCol/
  // toRow (or explicit pixel x1/y1/x2/y2) rather than a single cell.
  // ==========================================================================

  /**
   * Creates a new Wall segment on a scene. Endpoints are either explicit
   * pixel coordinates (x1/y1/x2/y2) or grid vertices (fromCol/fromRow ->
   * toCol/toRow, snapped to the scene's grid size — e.g. fromCol:3,
   * fromRow:5 -> toCol:4,toRow:5 is the one-cell-long top edge of cell
   * (3,5)). `type` selects a door/secretDoor/window preset (see
   * {@link WALL_TYPE_PRESETS}); a plain "wall" (default) is otherwise left
   * at Foundry's own Wall schema defaults (blocks movement and sight).
   *
   * @param sceneId - 16-char alphanumeric Scene document id
   * @param options - endpoints plus `type` (default "wall")
   * @returns the newly created wall document
   */
  async createWall(
    sceneId: string,
    options: {
      x1?: number;
      y1?: number;
      x2?: number;
      y2?: number;
      fromCol?: number;
      fromRow?: number;
      toCol?: number;
      toRow?: number;
      type?: WallType;
    } = {},
  ): Promise<unknown> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    const scene = this.worldData?.scenes.find((s) => s._id === sceneId);
    if (!scene) {
      throw new Error(`Scene not found: ${sceneId}`);
    }

    let x1: number;
    let y1: number;
    let x2: number;
    let y2: number;
    if (
      options.x1 !== undefined &&
      options.y1 !== undefined &&
      options.x2 !== undefined &&
      options.y2 !== undefined
    ) {
      ({ x1, y1, x2, y2 } = options);
    } else if (
      options.fromCol !== undefined &&
      options.fromRow !== undefined &&
      options.toCol !== undefined &&
      options.toRow !== undefined
    ) {
      const gridSize = extractGridSize(scene);
      x1 = options.fromCol * gridSize;
      y1 = options.fromRow * gridSize;
      x2 = options.toCol * gridSize;
      y2 = options.toRow * gridSize;
    } else {
      throw new Error(
        'Either x1/y1/x2/y2 or fromCol/fromRow/toCol/toRow is required to place the wall',
      );
    }
    if (![x1, y1, x2, y2].every((n) => Number.isFinite(n))) {
      throw new Error(`Invalid coordinates: (${x1}, ${y1}) -> (${x2}, ${y2})`);
    }
    if (x1 === x2 && y1 === y2) {
      throw new Error('Wall endpoints must differ — a zero-length wall is not valid');
    }

    const type = options.type ?? 'wall';
    const preset = WALL_TYPE_PRESETS[type];
    if (!preset) {
      throw new Error(
        `Invalid wall type: ${type}. Must be wall, door, secretDoor, terrain, invisible, or ethereal`,
      );
    }

    const wallData: Record<string, unknown> = { c: [x1, y1, x2, y2], ...preset };

    const result = await this.modifyDocument('Wall', 'create', {
      data: [wallData],
      parentUuid: `Scene.${sceneId}`,
    });
    return result[0];
  }

  /**
   * Removes a Wall from a scene (mirrors {@link deleteTile}).
   *
   * @param sceneId - 16-char alphanumeric Scene document id
   * @param wallId - 16-char alphanumeric Wall document id
   */
  async deleteWall(sceneId: string, wallId: string): Promise<void> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    if (!FOUNDRY_ID_PATTERN.test(wallId)) {
      throw new Error(`Invalid wallId format: ${wallId}`);
    }
    await this.modifyDocument('Wall', 'delete', {
      ids: [wallId],
      parentUuid: `Scene.${sceneId}`,
    });
  }

  /**
   * Lists the Walls on a scene, read from the cached worldData snapshot —
   * no network round trip. Lets a caller find a wallId for delete_wall/
   * set_door_state without guessing (mirrors {@link listTiles}).
   *
   * @param sceneId - 16-char alphanumeric Scene document id
   */
  listWalls(sceneId: string): Array<{
    id: string;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    move: number;
    sight: number;
    door: number;
    ds: number;
  }> {
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    const scene = this.worldData?.scenes.find((s) => s._id === sceneId);
    if (!scene) {
      throw new Error(`Scene not found: ${sceneId}`);
    }
    const walls = Array.isArray(scene.walls) ? scene.walls : [];
    return walls.map((w) => {
      const rec = w as Record<string, unknown>;
      const c = Array.isArray(rec.c) ? (rec.c as number[]) : [0, 0, 0, 0];
      return {
        id: typeof rec._id === 'string' ? rec._id : '',
        x1: c[0] ?? 0,
        y1: c[1] ?? 0,
        x2: c[2] ?? 0,
        y2: c[3] ?? 0,
        move: typeof rec.move === 'number' ? rec.move : 1,
        sight: typeof rec.sight === 'number' ? rec.sight : 1,
        door: typeof rec.door === 'number' ? rec.door : 0,
        ds: typeof rec.ds === 'number' ? rec.ds : 0,
      };
    });
  }

  /**
   * Lists the Tokens placed on a scene, read from the cached worldData
   * snapshot - no network round trip. Mirrors {@link listTiles}/
   * {@link listWalls}. Answers "what's on the canvas and where" without a
   * `capture_scene` screenshot or asking the user.
   *
   * @param sceneId - 16-char alphanumeric Scene document id
   */
  listTokens(sceneId: string): SceneToken[] {
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    const scene = this.worldData?.scenes.find((s) => s._id === sceneId);
    if (!scene) {
      throw new Error(`Scene not found: ${sceneId}`);
    }
    const tokens = Array.isArray(scene.tokens) ? scene.tokens : [];
    return tokens.map((t) => {
      const rec = t as Record<string, unknown>;
      return {
        id: typeof rec._id === 'string' ? rec._id : '',
        name: typeof rec.name === 'string' ? rec.name : '',
        actorId: typeof rec.actorId === 'string' ? rec.actorId : null,
        actorLink: rec.actorLink === true,
        x: typeof rec.x === 'number' ? rec.x : 0,
        y: typeof rec.y === 'number' ? rec.y : 0,
        width: typeof rec.width === 'number' ? rec.width : 1,
        height: typeof rec.height === 'number' ? rec.height : 1,
        elevation: typeof rec.elevation === 'number' ? rec.elevation : 0,
        rotation: typeof rec.rotation === 'number' ? rec.rotation : 0,
        hidden: rec.hidden === true,
        disposition: typeof rec.disposition === 'number' ? rec.disposition : 0,
      };
    });
  }

  // ==========================================================================
  // AmbientLight methods
  // ==========================================================================

  listLights(sceneId: string): SceneLight[] {
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    const scene = this.worldData?.scenes.find((s) => s._id === sceneId);
    if (!scene) {
      throw new Error(`Scene not found: ${sceneId}`);
    }
    const lights = Array.isArray(scene.lights) ? scene.lights : [];
    return lights.map((l) => {
      const rec = l as Record<string, unknown>;
      const config = isRecord(rec.config) ? (rec.config as Record<string, unknown>) : {};
      const anim = isRecord(config.animation) ? (config.animation as Record<string, unknown>) : {};
      return {
        id: typeof rec._id === 'string' ? rec._id : '',
        x: typeof rec.x === 'number' ? rec.x : 0,
        y: typeof rec.y === 'number' ? rec.y : 0,
        rotation: typeof rec.rotation === 'number' ? rec.rotation : 0,
        walls: rec.walls !== false,
        vision: rec.vision === true,
        hidden: rec.hidden === true,
        dim: typeof config.dim === 'number' ? config.dim : 0,
        bright: typeof config.bright === 'number' ? config.bright : 0,
        color: typeof config.color === 'string' ? config.color : null,
        angle: typeof config.angle === 'number' ? config.angle : 360,
        animationType: typeof anim.type === 'string' ? anim.type : null,
      };
    });
  }

  async createLight(
    sceneId: string,
    options: {
      x?: number;
      y?: number;
      gridCol?: number;
      gridRow?: number;
      dim?: number;
      bright?: number;
      color?: string;
      angle?: number;
      rotation?: number;
      animationType?: string;
      animationSpeed?: number;
      animationIntensity?: number;
      walls?: boolean;
      vision?: boolean;
      hidden?: boolean;
    } = {},
  ): Promise<unknown> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    const scene = this.worldData?.scenes.find((s) => s._id === sceneId);
    if (!scene) {
      throw new Error(`Scene not found: ${sceneId}`);
    }

    let x: number;
    let y: number;
    if (options.gridCol !== undefined && options.gridRow !== undefined) {
      const gridSize = extractGridSize(scene);
      x = options.gridCol * gridSize + gridSize / 2;
      y = options.gridRow * gridSize + gridSize / 2;
    } else if (options.x !== undefined && options.y !== undefined) {
      x = options.x;
      y = options.y;
    } else {
      throw new Error('Either x/y or gridCol/gridRow is required to place the light');
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`Invalid coordinates: (${x}, ${y}) — must be finite numbers`);
    }

    if (options.color && !HEX_COLOR_PATTERN.test(options.color)) {
      throw new Error(
        `Invalid color format: ${options.color} — must be a 6-digit hex color (e.g. #ff8800)`,
      );
    }

    const lightConfig: Record<string, unknown> = {
      dim: options.dim ?? 0,
      bright: options.bright ?? 0,
      angle: options.angle ?? 360,
    };
    if (options.color) {
      lightConfig.color = options.color;
    }
    if (options.animationType !== undefined) {
      lightConfig.animation = {
        type: options.animationType,
        speed: options.animationSpeed ?? 5,
        intensity: options.animationIntensity ?? 5,
      };
    }

    const data: Record<string, unknown> = {
      x,
      y,
      rotation: options.rotation ?? 0,
      walls: options.walls ?? true,
      vision: options.vision ?? false,
      hidden: options.hidden ?? false,
      config: lightConfig,
    };

    const result = await this.modifyDocument('AmbientLight', 'create', {
      data: [data],
      parentUuid: `Scene.${sceneId}`,
    });
    return result[0];
  }

  async updateLight(
    sceneId: string,
    lightId: string,
    patch: {
      x?: number;
      y?: number;
      dim?: number;
      bright?: number;
      color?: string;
      angle?: number;
      rotation?: number;
      walls?: boolean;
      vision?: boolean;
      hidden?: boolean;
    },
  ): Promise<unknown> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    if (!FOUNDRY_ID_PATTERN.test(lightId)) {
      throw new Error(`Invalid lightId format: ${lightId}`);
    }
    if (patch.color && !HEX_COLOR_PATTERN.test(patch.color)) {
      throw new Error(
        `Invalid color format: ${patch.color} — must be a 6-digit hex color (e.g. #ff8800)`,
      );
    }

    const update: Record<string, unknown> = { _id: lightId };
    if (patch.x !== undefined) {
      update.x = patch.x;
    }
    if (patch.y !== undefined) {
      update.y = patch.y;
    }
    if (patch.rotation !== undefined) {
      update.rotation = patch.rotation;
    }
    if (patch.walls !== undefined) {
      update.walls = patch.walls;
    }
    if (patch.vision !== undefined) {
      update.vision = patch.vision;
    }
    if (patch.hidden !== undefined) {
      update.hidden = patch.hidden;
    }
    if (patch.dim !== undefined) {
      update['config.dim'] = patch.dim;
    }
    if (patch.bright !== undefined) {
      update['config.bright'] = patch.bright;
    }
    if (patch.color !== undefined) {
      update['config.color'] = patch.color;
    }
    if (patch.angle !== undefined) {
      update['config.angle'] = patch.angle;
    }

    const result = await this.modifyDocument('AmbientLight', 'update', {
      updates: [update],
      parentUuid: `Scene.${sceneId}`,
      diff: true,
      recursive: true,
    });
    return result[0];
  }

  async deleteLight(sceneId: string, lightId: string): Promise<void> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    if (!FOUNDRY_ID_PATTERN.test(lightId)) {
      throw new Error(`Invalid lightId format: ${lightId}`);
    }
    await this.modifyDocument('AmbientLight', 'delete', {
      ids: [lightId],
      parentUuid: `Scene.${sceneId}`,
    });
  }

  // ==========================================================================
  // AmbientSound methods
  // ==========================================================================

  listSounds(sceneId: string): SceneSound[] {
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    const scene = this.worldData?.scenes.find((s) => s._id === sceneId);
    if (!scene) {
      throw new Error(`Scene not found: ${sceneId}`);
    }
    const sounds = Array.isArray(scene.sounds) ? scene.sounds : [];
    return sounds.map((s) => {
      const rec = s as Record<string, unknown>;
      return {
        id: typeof rec._id === 'string' ? rec._id : '',
        x: typeof rec.x === 'number' ? rec.x : 0,
        y: typeof rec.y === 'number' ? rec.y : 0,
        radius: typeof rec.radius === 'number' ? rec.radius : 0,
        path: typeof rec.path === 'string' ? rec.path : '',
        repeat: rec.repeat === true,
        volume: typeof rec.volume === 'number' ? rec.volume : 0.5,
        walls: rec.walls !== false,
        easing: rec.easing !== false,
        hidden: rec.hidden === true,
      };
    });
  }

  async createSound(
    sceneId: string,
    path: string,
    options: {
      x?: number;
      y?: number;
      gridCol?: number;
      gridRow?: number;
      radius?: number;
      volume?: number;
      repeat?: boolean;
      walls?: boolean;
      easing?: boolean;
      hidden?: boolean;
    } = {},
  ): Promise<unknown> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    if (!path || typeof path !== 'string') {
      throw new Error('path is required and must be a string');
    }
    const scene = this.worldData?.scenes.find((s) => s._id === sceneId);
    if (!scene) {
      throw new Error(`Scene not found: ${sceneId}`);
    }

    let x: number;
    let y: number;
    if (options.gridCol !== undefined && options.gridRow !== undefined) {
      const gridSize = extractGridSize(scene);
      x = options.gridCol * gridSize + gridSize / 2;
      y = options.gridRow * gridSize + gridSize / 2;
    } else if (options.x !== undefined && options.y !== undefined) {
      x = options.x;
      y = options.y;
    } else {
      throw new Error('Either x/y or gridCol/gridRow is required to place the sound');
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`Invalid coordinates: (${x}, ${y}) — must be finite numbers`);
    }

    const data: Record<string, unknown> = {
      x,
      y,
      path,
      radius: options.radius ?? 0,
      volume: options.volume ?? 0.5,
      repeat: options.repeat ?? false,
      walls: options.walls ?? true,
      easing: options.easing ?? true,
      hidden: options.hidden ?? false,
    };

    const result = await this.modifyDocument('AmbientSound', 'create', {
      data: [data],
      parentUuid: `Scene.${sceneId}`,
    });
    return result[0];
  }

  async deleteSound(sceneId: string, soundId: string): Promise<void> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    if (!FOUNDRY_ID_PATTERN.test(soundId)) {
      throw new Error(`Invalid soundId format: ${soundId}`);
    }
    await this.modifyDocument('AmbientSound', 'delete', {
      ids: [soundId],
      parentUuid: `Scene.${sceneId}`,
    });
  }

  // ==========================================================================
  // Note methods
  // ==========================================================================

  listNotes(sceneId: string): SceneNote[] {
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    const scene = this.worldData?.scenes.find((s) => s._id === sceneId);
    if (!scene) {
      throw new Error(`Scene not found: ${sceneId}`);
    }
    const notes = Array.isArray(scene.notes) ? scene.notes : [];
    return notes.map((n) => {
      const rec = n as Record<string, unknown>;
      return {
        id: typeof rec._id === 'string' ? rec._id : '',
        entryId: typeof rec.entryId === 'string' ? rec.entryId : null,
        pageId: typeof rec.pageId === 'string' ? rec.pageId : null,
        x: typeof rec.x === 'number' ? rec.x : 0,
        y: typeof rec.y === 'number' ? rec.y : 0,
        text: typeof rec.text === 'string' ? rec.text : '',
        iconSize: typeof rec.iconSize === 'number' ? rec.iconSize : 40,
        fontSize: typeof rec.fontSize === 'number' ? rec.fontSize : 32,
        textAnchor: typeof rec.textAnchor === 'number' ? rec.textAnchor : 1,
        global: rec.global === true,
      };
    });
  }

  async createNote(
    sceneId: string,
    options: {
      entryId?: string;
      pageId?: string;
      x?: number;
      y?: number;
      gridCol?: number;
      gridRow?: number;
      text?: string;
      iconSize?: number;
      fontSize?: number;
      textAnchor?: number;
      global?: boolean;
    } = {},
  ): Promise<unknown> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    if (!options.entryId && !options.text) {
      throw new Error(
        'A note needs entryId (a journal entry to link) or text (a standalone label), or both',
      );
    }
    if (options.entryId) {
      if (!FOUNDRY_ID_PATTERN.test(options.entryId)) {
        throw new Error(`Invalid entryId format: ${options.entryId}`);
      }
      const journalExists = this.worldData?.journal.some((j) => j._id === options.entryId);
      if (!journalExists) {
        throw new Error(`Journal entry not found: ${options.entryId}`);
      }
    }
    if (options.iconSize !== undefined && options.iconSize < 32) {
      throw new Error('iconSize must be an integer greater than or equal to 32');
    }

    const scene = this.worldData?.scenes.find((s) => s._id === sceneId);
    if (!scene) {
      throw new Error(`Scene not found: ${sceneId}`);
    }

    let x: number;
    let y: number;
    if (options.gridCol !== undefined && options.gridRow !== undefined) {
      const gridSize = extractGridSize(scene);
      x = options.gridCol * gridSize + gridSize / 2;
      y = options.gridRow * gridSize + gridSize / 2;
    } else if (options.x !== undefined && options.y !== undefined) {
      x = options.x;
      y = options.y;
    } else {
      throw new Error('Either x/y or gridCol/gridRow is required to place the note');
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`Invalid coordinates: (${x}, ${y}) — must be finite numbers`);
    }

    const data: Record<string, unknown> = {
      x,
      y,
      iconSize: options.iconSize ?? 40,
      fontSize: options.fontSize ?? 32,
      textAnchor: options.textAnchor ?? 1,
      global: options.global ?? false,
    };
    if (options.entryId) {
      data.entryId = options.entryId;
    }
    if (options.pageId) {
      data.pageId = options.pageId;
    }
    if (options.text !== undefined) {
      data.text = options.text;
    }

    const result = await this.modifyDocument('Note', 'create', {
      data: [data],
      parentUuid: `Scene.${sceneId}`,
    });
    return result[0];
  }

  async deleteNote(sceneId: string, noteId: string): Promise<void> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    if (!FOUNDRY_ID_PATTERN.test(noteId)) {
      throw new Error(`Invalid noteId format: ${noteId}`);
    }
    await this.modifyDocument('Note', 'delete', {
      ids: [noteId],
      parentUuid: `Scene.${sceneId}`,
    });
  }

  // ==========================================================================
  // Drawing methods
  // ==========================================================================

  listDrawings(sceneId: string): SceneDrawing[] {
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    const scene = this.worldData?.scenes.find((s) => s._id === sceneId);
    if (!scene) {
      throw new Error(`Scene not found: ${sceneId}`);
    }
    const drawings = Array.isArray(scene.drawings) ? scene.drawings : [];
    return drawings.map((d) => {
      const rec = d as Record<string, unknown>;
      const shape = isRecord(rec.shape) ? (rec.shape as Record<string, unknown>) : {};
      return {
        id: typeof rec._id === 'string' ? rec._id : '',
        shapeType: typeof shape.type === 'string' ? shape.type : 'r',
        x: typeof rec.x === 'number' ? rec.x : 0,
        y: typeof rec.y === 'number' ? rec.y : 0,
        width: typeof shape.width === 'number' ? shape.width : null,
        height: typeof shape.height === 'number' ? shape.height : null,
        radius: typeof shape.radius === 'number' ? shape.radius : null,
        points: Array.isArray(shape.points) ? (shape.points as number[]) : [],
        rotation: typeof rec.rotation === 'number' ? rec.rotation : 0,
        strokeColor: typeof rec.strokeColor === 'string' ? rec.strokeColor : null,
        fillType: typeof rec.fillType === 'number' ? rec.fillType : 0,
        fillColor: typeof rec.fillColor === 'string' ? rec.fillColor : null,
        text: typeof rec.text === 'string' ? rec.text : '',
        fontSize: typeof rec.fontSize === 'number' ? rec.fontSize : 48,
        hidden: rec.hidden === true,
        locked: rec.locked === true,
      };
    });
  }

  async createDrawing(
    sceneId: string,
    options: {
      shape?: 'r' | 'c' | 'e' | 'p';
      x: number;
      y: number;
      width?: number;
      height?: number;
      radius?: number;
      points?: number[];
      rotation?: number;
      strokeColor?: string;
      strokeWidth?: number;
      fillType?: 0 | 1 | 2;
      fillColor?: string;
      fillAlpha?: number;
      text?: string;
      fontSize?: number;
      hidden?: boolean;
      locked?: boolean;
    },
  ): Promise<unknown> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    if (
      typeof options.x !== 'number' ||
      !Number.isFinite(options.x) ||
      typeof options.y !== 'number' ||
      !Number.isFinite(options.y)
    ) {
      throw new Error(`Invalid coordinates: (${options.x}, ${options.y}) — must be finite numbers`);
    }

    const shapeType = options.shape ?? 'r';
    const shapeData: Record<string, unknown> = { type: shapeType };

    if (shapeType === 'r' || shapeType === 'e') {
      if (options.width === undefined || options.height === undefined) {
        throw new Error('width and height are required for rectangle/ellipse shapes');
      }
      shapeData.width = options.width;
      shapeData.height = options.height;
    } else if (shapeType === 'c') {
      if (options.radius === undefined || options.radius <= 0) {
        throw new Error('radius (positive number) is required for circle shape');
      }
      shapeData.radius = options.radius;
    } else if (shapeType === 'p') {
      if (
        !Array.isArray(options.points) ||
        options.points.length < 6 ||
        options.points.length % 2 !== 0
      ) {
        throw new Error(
          'points array with at least 6 coordinates (3 vertex pairs) is required for polygon shape',
        );
      }
      shapeData.points = options.points;
    } else {
      throw new Error(
        `Invalid shape type: ${shapeType} — must be r (rectangle), c (circle), e (ellipse), or p (polygon)`,
      );
    }

    if (options.strokeColor && !HEX_COLOR_PATTERN.test(options.strokeColor)) {
      throw new Error(
        `Invalid strokeColor format: ${options.strokeColor} — must be a 6-digit hex color`,
      );
    }
    if (options.fillColor && !HEX_COLOR_PATTERN.test(options.fillColor)) {
      throw new Error(
        `Invalid fillColor format: ${options.fillColor} — must be a 6-digit hex color`,
      );
    }

    let fillType = options.fillType ?? 0;
    if (options.fillColor && options.fillType === undefined) {
      fillType = 1; // Solid fill if color provided
    }

    const data: Record<string, unknown> = {
      x: options.x,
      y: options.y,
      shape: shapeData,
      author: this.worldData?.userId,
      rotation: options.rotation ?? 0,
      fillType,
      strokeWidth: options.strokeWidth ?? 8,
      fontSize: options.fontSize ?? 48,
      hidden: options.hidden ?? false,
      locked: options.locked ?? false,
    };
    if (options.fillColor) {
      data.fillColor = options.fillColor;
    }
    if (options.fillAlpha !== undefined) {
      data.fillAlpha = options.fillAlpha;
    }
    if (options.strokeColor) {
      data.strokeColor = options.strokeColor;
    }
    if (options.text !== undefined) {
      data.text = options.text;
    }

    const result = await this.modifyDocument('Drawing', 'create', {
      data: [data],
      parentUuid: `Scene.${sceneId}`,
    });
    return result[0];
  }

  async deleteDrawing(sceneId: string, drawingId: string): Promise<void> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    if (!FOUNDRY_ID_PATTERN.test(drawingId)) {
      throw new Error(`Invalid drawingId format: ${drawingId}`);
    }
    await this.modifyDocument('Drawing', 'delete', {
      ids: [drawingId],
      parentUuid: `Scene.${sceneId}`,
    });
  }

  // ==========================================================================
  // MeasuredTemplate methods
  // ==========================================================================

  listTemplates(sceneId: string): SceneTemplate[] {
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    const scene = this.worldData?.scenes.find((s) => s._id === sceneId);
    if (!scene) {
      throw new Error(`Scene not found: ${sceneId}`);
    }
    const templates = Array.isArray(scene.templates) ? scene.templates : [];
    return templates.map((t) => {
      const rec = t as Record<string, unknown>;
      return {
        id: typeof rec._id === 'string' ? rec._id : '',
        t: typeof rec.t === 'string' ? rec.t : 'circle',
        x: typeof rec.x === 'number' ? rec.x : 0,
        y: typeof rec.y === 'number' ? rec.y : 0,
        distance: typeof rec.distance === 'number' ? rec.distance : 0,
        direction: typeof rec.direction === 'number' ? rec.direction : 0,
        angle: typeof rec.angle === 'number' ? rec.angle : 0,
        width: typeof rec.width === 'number' ? rec.width : 0,
        borderColor: typeof rec.borderColor === 'string' ? rec.borderColor : null,
        fillColor: typeof rec.fillColor === 'string' ? rec.fillColor : null,
        hidden: rec.hidden === true,
      };
    });
  }

  async createTemplate(
    sceneId: string,
    options: {
      t?: 'circle' | 'cone' | 'rect' | 'ray';
      x?: number;
      y?: number;
      gridCol?: number;
      gridRow?: number;
      distance: number;
      direction?: number;
      angle?: number;
      width?: number;
      borderColor?: string;
      fillColor?: string;
      hidden?: boolean;
    },
  ): Promise<unknown> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    if (
      typeof options.distance !== 'number' ||
      !Number.isFinite(options.distance) ||
      options.distance < 0
    ) {
      throw new Error('distance is required and must be a finite non-negative number');
    }
    const scene = this.worldData?.scenes.find((s) => s._id === sceneId);
    if (!scene) {
      throw new Error(`Scene not found: ${sceneId}`);
    }

    let x: number;
    let y: number;
    if (options.gridCol !== undefined && options.gridRow !== undefined) {
      const gridSize = extractGridSize(scene);
      x = options.gridCol * gridSize + gridSize / 2;
      y = options.gridRow * gridSize + gridSize / 2;
    } else if (options.x !== undefined && options.y !== undefined) {
      x = options.x;
      y = options.y;
    } else {
      throw new Error('Either x/y or gridCol/gridRow is required to place the template');
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`Invalid coordinates: (${x}, ${y}) — must be finite numbers`);
    }

    const t = options.t ?? 'circle';
    if (t === 'cone') {
      if (options.direction === undefined || options.angle === undefined) {
        throw new Error('distance, direction, and angle are required for cone templates');
      }
    } else if (t === 'ray') {
      if (options.direction === undefined || options.width === undefined) {
        throw new Error('distance, direction, and width are required for ray templates');
      }
    } else if (t === 'rect') {
      if (options.direction === undefined) {
        throw new Error('distance and direction are required for rectangle templates');
      }
    } else if (t !== 'circle') {
      throw new Error(`Invalid template type: ${t} — must be circle, cone, rect, or ray`);
    }

    if (options.borderColor && !HEX_COLOR_PATTERN.test(options.borderColor)) {
      throw new Error(
        `Invalid borderColor format: ${options.borderColor} — must be a 6-digit hex color`,
      );
    }
    if (options.fillColor && !HEX_COLOR_PATTERN.test(options.fillColor)) {
      throw new Error(
        `Invalid fillColor format: ${options.fillColor} — must be a 6-digit hex color`,
      );
    }

    const data: Record<string, unknown> = {
      t,
      x,
      y,
      distance: options.distance,
      direction: options.direction ?? 0,
      angle: options.angle ?? 0,
      width: options.width ?? 0,
      author: this.worldData?.userId,
      hidden: options.hidden ?? false,
    };
    if (options.borderColor) {
      data.borderColor = options.borderColor;
    }
    if (options.fillColor) {
      data.fillColor = options.fillColor;
    }

    const result = await this.modifyDocument('MeasuredTemplate', 'create', {
      data: [data],
      parentUuid: `Scene.${sceneId}`,
    });
    return result[0];
  }

  async deleteTemplate(sceneId: string, templateId: string): Promise<void> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    if (!FOUNDRY_ID_PATTERN.test(templateId)) {
      throw new Error(`Invalid templateId format: ${templateId}`);
    }
    await this.modifyDocument('MeasuredTemplate', 'delete', {
      ids: [templateId],
      parentUuid: `Scene.${sceneId}`,
    });
  }

  // ==========================================================================
  // Region methods (FoundryVTT v12+)
  // ==========================================================================

  listRegions(sceneId: string): SceneRegion[] {
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    const scene = this.worldData?.scenes.find((s) => s._id === sceneId);
    if (!scene) {
      throw new Error(`Scene not found: ${sceneId}`);
    }
    const regions = Array.isArray(scene.regions) ? scene.regions : [];
    return regions.map((r) => {
      const rec = r as Record<string, unknown>;
      const elev = isRecord(rec.elevation) ? (rec.elevation as Record<string, unknown>) : {};
      const shapes = Array.isArray(rec.shapes) ? rec.shapes : [];
      const behaviors = Array.isArray(rec.behaviors) ? rec.behaviors : [];
      return {
        id: typeof rec._id === 'string' ? rec._id : '',
        name: typeof rec.name === 'string' ? rec.name : '',
        color: typeof rec.color === 'string' ? rec.color : null,
        elevation: {
          bottom: typeof elev.bottom === 'number' ? elev.bottom : null,
          top: typeof elev.top === 'number' ? elev.top : null,
        },
        shapesCount: shapes.length,
        behaviorsCount: behaviors.length,
      };
    });
  }

  async createRegion(
    sceneId: string,
    options: {
      name: string;
      color?: string;
      visibility?: number;
      elevation?: { bottom?: number; top?: number };
      shapes?: Array<
        | { type: 'rectangle'; x: number; y: number; width: number; height: number }
        | { type: 'circle'; x: number; y: number; radius: number }
        | { type: 'polygon'; points: number[] }
      >;
      behaviors?: Array<{ type: string; system?: Record<string, unknown>; disabled?: boolean }>;
    },
  ): Promise<unknown> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    if (!options.name || typeof options.name !== 'string') {
      throw new Error('name is required and must be a string');
    }
    if (options.color && !HEX_COLOR_PATTERN.test(options.color)) {
      throw new Error(
        `Invalid color format: ${options.color} — must be a 6-digit hex color (e.g. #ff8800)`,
      );
    }

    const mappedShapes: Array<Record<string, unknown>> = [];
    if (options.shapes) {
      for (const shape of options.shapes) {
        if (shape.type === 'rectangle') {
          if (
            !Number.isFinite(shape.x) ||
            !Number.isFinite(shape.y) ||
            !Number.isFinite(shape.width) ||
            !Number.isFinite(shape.height)
          ) {
            throw new Error('rectangle shape requires finite x, y, width, height');
          }
          mappedShapes.push({
            type: 'rectangle',
            x: shape.x,
            y: shape.y,
            width: shape.width,
            height: shape.height,
          });
        } else if (shape.type === 'circle') {
          if (
            !Number.isFinite(shape.x) ||
            !Number.isFinite(shape.y) ||
            !Number.isFinite(shape.radius) ||
            shape.radius <= 0
          ) {
            throw new Error('circle shape requires finite x, y and positive radius');
          }
          mappedShapes.push({
            type: 'circle',
            x: shape.x,
            y: shape.y,
            radius: shape.radius,
          });
        } else if (shape.type === 'polygon') {
          if (
            !Array.isArray(shape.points) ||
            shape.points.length < 6 ||
            shape.points.length % 2 !== 0
          ) {
            throw new Error('polygon shape requires points array with at least 3 (x, y) pairs');
          }
          mappedShapes.push({ type: 'polygon', points: shape.points });
        }
      }
    }

    const regionData: Record<string, unknown> = {
      name: options.name,
      shapes: mappedShapes,
    };
    if (options.color) {
      regionData.color = options.color;
    }
    if (options.visibility !== undefined) {
      regionData.visibility = options.visibility;
    }
    if (options.elevation) {
      regionData.elevation = options.elevation;
    }
    if (options.behaviors) {
      regionData.behaviors = options.behaviors;
    }

    const result = await this.modifyDocument('Region', 'create', {
      data: [regionData],
      parentUuid: `Scene.${sceneId}`,
    });
    return result[0];
  }

  async deleteRegion(sceneId: string, regionId: string): Promise<void> {
    this.assertWriteable();
    if (!FOUNDRY_ID_PATTERN.test(sceneId)) {
      throw new Error(`Invalid sceneId format: ${sceneId}`);
    }
    if (!FOUNDRY_ID_PATTERN.test(regionId)) {
      throw new Error(`Invalid regionId format: ${regionId}`);
    }
    await this.modifyDocument('Region', 'delete', {
      ids: [regionId],
      parentUuid: `Scene.${sceneId}`,
    });
  }

  // ==========================================================================
  // Cross-collection search
  // ==========================================================================

  searchWorld(query: string): {
    actors: WorldActor[];
    items: WorldItem[];
    scenes: WorldScene[];
    journals: WorldJournal[];
  } {
    if (!this.worldData) {
      return { actors: [], items: [], scenes: [], journals: [] };
    }

    const q = query.toLowerCase();

    return {
      actors: this.worldData.actors.filter((a) => a.name.toLowerCase().includes(q)),
      items: this.worldData.items.filter((i) => i.name.toLowerCase().includes(q)),
      scenes: this.worldData.scenes.filter((s) => s.name.toLowerCase().includes(q)),
      journals: this.worldData.journal.filter((j) => j.name.toLowerCase().includes(q)),
    };
  }

  // ==========================================================================
  // World summary
  // ==========================================================================

  getWorldSummary(): Record<string, number> {
    if (!this.worldData) {
      return {};
    }
    return {
      actors: this.worldData.actors.length,
      items: this.worldData.items.length,
      scenes: this.worldData.scenes.length,
      journals: this.worldData.journal.length,
      combats: this.worldData.combats.length,
      users: this.worldData.users.length,
      messages: this.worldData.messages.length,
      macros: this.worldData.macros.length,
      playlists: this.worldData.playlists.length,
      tables: this.worldData.tables.length,
      folders: this.worldData.folders.length,
    };
  }

  // ==========================================================================
  // Dice rolling
  // ==========================================================================

  /**
   * Rolls a dice formula.
   *
   * Validation is deliberately **per transport**, because the two transports
   * are not equally capable (laurigates/foundryvtt-mcp#219):
   *
   *  - **REST (`FOUNDRY_API_KEY`)** posts the formula to `/api/dice/roll`,
   *    where FoundryVTT's own `Roll` engine evaluates it. That engine
   *    understands more than this module does — parentheses, for one — so only
   *    the `DICE_FORMULA_ALPHABET` check applies here. Imposing the local
   *    parser's narrower grammar would take away a capability the transport
   *    has. What the alphabet does refuse is refused by name and position
   *    (`unexpected "k" at position 3`, via `alphabetViolation`), so the
   *    two transports are equally specific about what they would not evaluate.
   *  - **Socket.IO / no API key** has no remote evaluator: `fallbackDiceRoll`
   *    is the roller, so the grammar its parser can represent is the grammar
   *    accepted, and that parser is the *only* gate. No alphabet pre-check runs
   *    ahead of it, so its specific message (`unexpected "k" at position 3`)
   *    reaches the caller instead of a generic `Invalid dice formula: 4d6kh3`.
   *    Nothing is ever dropped from a total in silence.
   *
   * The length cap is common to both. A REST roll that cannot reach FoundryVTT
   * falls through to the local roller, which then applies the strict grammar —
   * a formula only Foundry could evaluate errors out rather than being
   * mis-totalled locally.
   */
  async rollDice(formula: string, reason?: string): Promise<DiceRoll> {
    if (typeof formula !== 'string' || formula.length > MAX_DICE_FORMULA_LENGTH) {
      throw new Error(`Invalid dice formula: ${formula}`);
    }

    if (this.config.apiKey) {
      if (!formula || !DICE_FORMULA_ALPHABET.test(formula)) {
        throw alphabetViolation(formula);
      }

      try {
        const response = await this.http.post('/api/dice/roll', {
          formula,
          flavor: reason,
        });

        const rolled = RestDiceRollSchema.parse(response.data);

        const result: DiceRoll = {
          formula,
          total: rolled.total,
          breakdown: rolled.terms?.map((term) => term.results?.join(', ')).join(' + ') || formula,
          timestamp: new Date().toISOString(),
        };
        if (reason) {
          result.reason = reason;
        }
        return result;
      } catch {
        // Fall through to local roll
      }
    }

    return this.fallbackDiceRoll(formula, reason);
  }

  /**
   * Rolls locally, when FoundryVTT is not doing it for us.
   *
   * Delegates the whole formula to {@link evaluateDiceFormula}, which consumes
   * the input end to end and throws on any leftover it cannot represent (laurigates/foundryvtt-mcp#219).
   */
  private fallbackDiceRoll(formula: string, reason?: string): DiceRoll {
    const { total, breakdown } = evaluateDiceFormula(formula);

    const result: DiceRoll = {
      formula,
      total,
      breakdown,
      timestamp: new Date().toISOString(),
    };
    if (reason) {
      result.reason = reason;
    }
    return result;
  }

  // ==========================================================================
  // Connection test
  // ==========================================================================

  async testConnection(): Promise<boolean> {
    try {
      if (this.config.username && this.config.password) {
        await this.connect();
        return true;
      }

      const response = await this.http.get('/');
      logger.debug('Connection test successful', { status: response.status });
      return true;
    } catch (error) {
      logger.error('Failed to connect to FoundryVTT:', error);
      throw error;
    }
  }

  // ==========================================================================
  // HTTP helpers (preserved for REST API mode and diagnostics)
  // ==========================================================================

  private async executeWithRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;
    const maxAttempts = (this.config.retryAttempts || 3) + 1;
    const baseDelay = this.config.retryDelay || 1000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;

        if (axios.isAxiosError(error)) {
          const status = error.response?.status;
          if (status && status >= 400 && status < 500 && status !== 429) {
            throw lastError;
          }
        }

        if (attempt === maxAttempts) {
          throw lastError;
        }

        const exponentialDelay = baseDelay * 2 ** (attempt - 1);
        const jitter = Math.random() * 0.1 * exponentialDelay;
        await new Promise((resolve) => setTimeout(resolve, exponentialDelay + jitter));
      }
    }

    throw lastError || new Error('Request failed after all retry attempts');
  }

  async get<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.executeWithRetry(() => this.http.get(url, config));
  }

  async post<T = unknown>(
    url: string,
    data?: unknown,
    config?: AxiosRequestConfig,
  ): Promise<AxiosResponse<T>> {
    return this.executeWithRetry(() => this.http.post(url, data, config));
  }

  async put<T = unknown>(
    url: string,
    data?: unknown,
    config?: AxiosRequestConfig,
  ): Promise<AxiosResponse<T>> {
    return this.executeWithRetry(() => this.http.put(url, data, config));
  }

  async delete<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.executeWithRetry(() => this.http.delete(url, config));
  }
}

// ============================================================================
// Wall-aware pathfinding — pure geometry, no canvas (see moveTokenPathfind)
//
// Ported from alexivenkov/foundry-api-bridge-module (MIT license):
// GridPathfinder.ts (A* search) + DoorAwareCollision.ts (segment-intersection
// wall collision), adapted to run headless against the plain wall records
// already cached in WorldScene.walls instead of Foundry's client-side
// ClockwiseSweepPolygon collision backend.
// ============================================================================

interface PathPoint {
  x: number;
  y: number;
}

interface PathWallInfo {
  id: string;
  c: number[];
  door: number;
  ds: number;
  move: number;
}

interface PathDoorCrossing {
  wallId: string;
  betweenIndex: number;
}

/**
 * Resolves after `ms` milliseconds.
 *
 * Plain executor deliberately, not `Promise.withResolvers` — this project's
 * `engines` requires Node 18+, which predates that API (Node 22+/ES2024).
 */
function pathDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractGridSize(scene: WorldScene): number {
  const grid = scene.grid;
  const size = isRecord(grid) ? grid.size : undefined;
  return typeof size === 'number' && size > 0 ? size : 100;
}

function extractWallInfos(scene: WorldScene): PathWallInfo[] {
  const walls = Array.isArray(scene.walls) ? scene.walls : [];
  return walls.map((w) => {
    const rec = w as Record<string, unknown>;
    return {
      id: typeof rec._id === 'string' ? rec._id : '',
      c: Array.isArray(rec.c) ? (rec.c as number[]) : [0, 0, 0, 0],
      door: typeof rec.door === 'number' ? rec.door : 0,
      ds: typeof rec.ds === 'number' ? rec.ds : 0,
      move: typeof rec.move === 'number' ? rec.move : 1,
    };
  });
}

function pathDirection(a: PathPoint, b: PathPoint, c: PathPoint): number {
  return (c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x);
}

function pathSegmentsIntersect(
  p1: PathPoint,
  p2: PathPoint,
  p3: PathPoint,
  p4: PathPoint,
): boolean {
  const d1 = pathDirection(p3, p4, p1);
  const d2 = pathDirection(p3, p4, p2);
  const d3 = pathDirection(p1, p2, p3);
  const d4 = pathDirection(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function onPathSegment(p: PathPoint, q: PathPoint, r: PathPoint): boolean {
  return (
    r.x <= Math.max(p.x, q.x) &&
    r.x >= Math.min(p.x, q.x) &&
    r.y <= Math.max(p.y, q.y) &&
    r.y >= Math.min(p.y, q.y)
  );
}

function pathSegmentsIntersectRelaxed(
  p1: PathPoint,
  p2: PathPoint,
  p3: PathPoint,
  p4: PathPoint,
): boolean {
  const d1 = pathDirection(p3, p4, p1);
  const d2 = pathDirection(p3, p4, p2);
  const d3 = pathDirection(p1, p2, p3);
  const d4 = pathDirection(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  if (d1 === 0 && onPathSegment(p3, p4, p1)) {
    return true;
  }
  if (d2 === 0 && onPathSegment(p3, p4, p2)) {
    return true;
  }
  if (d3 === 0 && onPathSegment(p1, p2, p3)) {
    return true;
  }
  if (d4 === 0 && onPathSegment(p1, p2, p4)) {
    return true;
  }
  return false;
}

function pathWallSegment(wall: PathWallInfo): [PathPoint, PathPoint] {
  return [
    { x: wall.c[0] ?? 0, y: wall.c[1] ?? 0 },
    { x: wall.c[2] ?? 0, y: wall.c[3] ?? 0 },
  ];
}

interface PathRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function pointInRect(p: PathPoint, rect: PathRect): boolean {
  return (
    p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height
  );
}

/**
 * True if the segment `p1`-`p2` crosses, touches, or is fully contained by
 * `rect` — used to test whether a tile's bounding box overlaps a wall.
 * Checked against all 4 rect edges (catches a crossing/touching segment)
 * plus an endpoint-in-rect check (catches a segment fully inside the rect,
 * which would not intersect any edge).
 */
function rectIntersectsSegment(rect: PathRect, p1: PathPoint, p2: PathPoint): boolean {
  if (pointInRect(p1, rect) || pointInRect(p2, rect)) {
    return true;
  }
  const corners: PathPoint[] = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
  for (let i = 0; i < 4; i++) {
    const a = corners[i] as PathPoint;
    const b = corners[(i + 1) % 4] as PathPoint;
    if (pathSegmentsIntersectRelaxed(p1, p2, a, b)) {
      return true;
    }
  }
  return false;
}

/** True if the straight pixel-space line from `from` to `to` crosses any impassable wall. */
function isDirectPathBlocked(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  tokenW: number,
  tokenH: number,
  gridSize: number,
  impassableWalls: PathWallInfo[],
): boolean {
  for (let i = 0; i < tokenW; i++) {
    for (let j = 0; j < tokenH; j++) {
      const origin = {
        x: fromX + i * gridSize + gridSize / 2,
        y: fromY + j * gridSize + gridSize / 2,
      };
      const dest = { x: toX + i * gridSize + gridSize / 2, y: toY + j * gridSize + gridSize / 2 };
      for (const wall of impassableWalls) {
        const [p3, p4] = pathWallSegment(wall);
        if (pathSegmentsIntersect(origin, dest, p3, p4)) {
          return true;
        }
      }
    }
  }
  return false;
}

/** Same check in grid-cell space, used by the A* neighbor expansion below. */
function isCellBlocked(
  fromGX: number,
  fromGY: number,
  toGX: number,
  toGY: number,
  gridSize: number,
  tokenW: number,
  tokenH: number,
  impassableWalls: PathWallInfo[],
): boolean {
  const center = (g: number): number => g * gridSize + gridSize / 2;
  for (let i = 0; i < tokenW; i++) {
    for (let j = 0; j < tokenH; j++) {
      const origin = { x: center(fromGX + i), y: center(fromGY + j) };
      const dest = { x: center(toGX + i), y: center(toGY + j) };
      for (const wall of impassableWalls) {
        const [p3, p4] = pathWallSegment(wall);
        if (pathSegmentsIntersect(origin, dest, p3, p4)) {
          return true;
        }
      }
    }
  }
  return false;
}

const PATH_MAX_NODES = 2500;
const PATH_DIRECTIONS: ReadonlyArray<[number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
];

function pathChebyshev(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

function pathKey(gx: number, gy: number): string {
  return `${gx},${gy}`;
}

function reconstructGridPath(
  cameFrom: Map<string, string>,
  endGX: number,
  endGY: number,
  gridSize: number,
): PathPoint[] {
  const path: PathPoint[] = [];
  let key = pathKey(endGX, endGY);
  while (cameFrom.has(key)) {
    const [gxStr, gyStr] = key.split(',');
    path.push({ x: Number(gxStr) * gridSize, y: Number(gyStr) * gridSize });
    key = cameFrom.get(key) ?? '';
  }
  path.reverse();
  return path;
}

/** A* over the grid, avoiding `impassableWalls`. Returns null if no route exists within the node budget. */
function findGridTokenPath(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  gridSize: number,
  tokenW: number,
  tokenH: number,
  impassableWalls: PathWallInfo[],
): { path: PathPoint[]; cost: number } | null {
  const startGX = Math.floor(startX / gridSize);
  const startGY = Math.floor(startY / gridSize);
  const endGX = Math.floor(endX / gridSize);
  const endGY = Math.floor(endY / gridSize);
  if (startGX === endGX && startGY === endGY) {
    return { path: [], cost: 0 };
  }

  const startKey = pathKey(startGX, startGY);
  const openSet: Array<{ gx: number; gy: number; g: number; f: number }> = [
    { gx: startGX, gy: startGY, g: 0, f: pathChebyshev(startGX, startGY, endGX, endGY) },
  ];
  const gScore = new Map<string, number>([[startKey, 0]]);
  const cameFrom = new Map<string, string>();
  const closed = new Set<string>();
  let explored = 0;

  while (openSet.length > 0) {
    if (explored >= PATH_MAX_NODES) {
      return null;
    }
    let minIdx = 0;
    let minF = openSet[0]?.f ?? Number.POSITIVE_INFINITY;
    for (let i = 1; i < openSet.length; i++) {
      const f = openSet[i]?.f ?? Number.POSITIVE_INFINITY;
      if (f < minF) {
        minF = f;
        minIdx = i;
      }
    }
    const current = openSet[minIdx];
    if (!current) {
      break;
    }
    if (current.gx === endGX && current.gy === endGY) {
      return { path: reconstructGridPath(cameFrom, endGX, endGY, gridSize), cost: current.g };
    }
    openSet.splice(minIdx, 1);
    const currentKey = pathKey(current.gx, current.gy);
    closed.add(currentKey);
    explored++;

    for (const [dx, dy] of PATH_DIRECTIONS) {
      const nx = current.gx + dx;
      const ny = current.gy + dy;
      const neighborKey = pathKey(nx, ny);
      if (closed.has(neighborKey)) {
        continue;
      }
      if (
        isCellBlocked(current.gx, current.gy, nx, ny, gridSize, tokenW, tokenH, impassableWalls)
      ) {
        continue;
      }
      const tentativeG = current.g + 1;
      const existingG = gScore.get(neighborKey);
      if (existingG !== undefined && tentativeG >= existingG) {
        continue;
      }
      cameFrom.set(neighborKey, currentKey);
      gScore.set(neighborKey, tentativeG);
      const f = tentativeG + pathChebyshev(nx, ny, endGX, endGY);
      const existingIdx = openSet.findIndex((n) => n.gx === nx && n.gy === ny);
      if (existingIdx >= 0) {
        const existing = openSet[existingIdx];
        if (existing) {
          existing.g = tentativeG;
          existing.f = f;
        }
      } else {
        openSet.push({ gx: nx, gy: ny, g: tentativeG, f });
      }
    }
  }
  return null;
}

/** Which openable doors the given waypoint path crosses, and at which waypoint index. */
function findDoorsOnPath(
  startX: number,
  startY: number,
  gridSize: number,
  path: PathPoint[],
  openableDoors: PathWallInfo[],
): PathDoorCrossing[] {
  const centers: PathPoint[] = [
    { x: startX + gridSize / 2, y: startY + gridSize / 2 },
    ...path.map((p) => ({ x: p.x + gridSize / 2, y: p.y + gridSize / 2 })),
  ];
  const result: PathDoorCrossing[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < centers.length - 1; i++) {
    const from = centers[i];
    const to = centers[i + 1];
    if (!from || !to) {
      continue;
    }
    for (const door of openableDoors) {
      if (seen.has(door.id)) {
        continue;
      }
      const [p3, p4] = pathWallSegment(door);
      if (pathSegmentsIntersectRelaxed(from, to, p3, p4)) {
        result.push({ wallId: door.id, betweenIndex: i });
        seen.add(door.id);
      }
    }
  }
  return result;
}

// ============================================================================
// Mapping helpers — WorldData raw documents → display interfaces
// ============================================================================

function worldActorToFoundry(a: WorldActor): FoundryActor {
  const sys = a.system || {};
  const hpRaw = extractNested(sys, 'attributes', 'hp');
  const hp = isRecord(hpRaw) ? hpRaw : undefined;
  const acRaw = extractNested(sys, 'attributes', 'ac');
  const ac = isRecord(acRaw) ? acRaw : undefined;
  const details = isRecord(sys.details) ? sys.details : {};

  const abilitiesRaw = sys.abilities;
  let mappedAbilities: FoundryActor['abilities'];
  if (isRecord(abilitiesRaw)) {
    mappedAbilities = {};
    for (const [key, val] of Object.entries(abilitiesRaw)) {
      if (isRecord(val)) {
        const entry: { value: number; mod: number; save?: number } = {
          value: typeof val.value === 'number' ? val.value : 10,
          mod: typeof val.mod === 'number' ? val.mod : 0,
        };
        if (typeof val.save === 'number') {
          entry.save = val.save;
        }
        mappedAbilities[key] = entry;
      }
    }
  }

  const actor: FoundryActor = {
    _id: a._id,
    name: a.name,
    type: a.type,
  };

  if (a.img) {
    actor.img = a.img;
  }

  if (hp) {
    const hpValue = typeof hp.value === 'number' ? hp.value : 0;
    const hpMax = typeof hp.max === 'number' ? hp.max : 0;
    const hpObj: { value: number; max: number; temp?: number } = { value: hpValue, max: hpMax };
    if (typeof hp.temp === 'number') {
      hpObj.temp = hp.temp;
    }
    actor.hp = hpObj;
  }

  if (ac && typeof ac.value === 'number') {
    actor.ac = { value: ac.value };
  }

  if (typeof details.level === 'number') {
    actor.level = details.level;
  }

  if (mappedAbilities) {
    actor.abilities = mappedAbilities;
  }

  const bio = extractString(details, 'biography', 'value') || extractString(details, 'biography');
  if (bio) {
    actor.biography = bio;
  }

  return actor;
}

function worldSceneToFoundry(s: WorldScene): FoundryScene {
  const scene: FoundryScene = {
    _id: s._id,
    name: s.name,
    active: s.active,
    navigation: s.navigation,
    width: s.width,
    height: s.height,
    padding: s.padding,
    shiftX: 0,
    shiftY: 0,
    globalLight: s.globalLight,
    darkness: s.darkness,
  };
  if (s.img) {
    scene.img = s.img;
  }
  if (isRecord(s.grid)) {
    const g = s.grid;
    scene.grid = {
      type: typeof g.type === 'number' ? g.type : 1,
      size: typeof g.size === 'number' ? g.size : 100,
      color: typeof g.color === 'string' ? g.color : '#000000',
      alpha: typeof g.alpha === 'number' ? g.alpha : 0.2,
      distance: typeof g.distance === 'number' ? g.distance : 1,
      units: typeof g.units === 'string' ? g.units : '',
    };
  }
  const desc = (s.flags as Record<string, unknown>)?.description;
  if (typeof desc === 'string') {
    scene.description = desc;
  }
  return scene;
}

/**
 * An unlinked token's effects or items: the base actor's, each replaced by the
 * delta's entry with the same id, then the delta's own, without the entries
 * the delta tombstoned. Builds a new array and leaves the cache as it is.
 */
function mergeDeltaEntries<T extends { _id: string }>(base: T[], delta: unknown): T[] {
  const deltaEntries = Array.isArray(delta)
    ? delta.filter((entry): entry is T => isRecord(entry) && typeof entry._id === 'string')
    : [];
  const byId = new Map(deltaEntries.map((entry) => [entry._id, entry]));
  const baseIds = new Set(base.map((entry) => entry._id));
  return [
    ...base.map((entry) => byId.get(entry._id) ?? entry),
    ...deltaEntries.filter((entry) => !baseIds.has(entry._id)),
  ].filter((entry) => (entry as { _tombstone?: unknown })._tombstone !== true);
}

/**
 * Returns the `system` object of an actor-like document, accepting either the
 * raw REST/world document (`{ ..., system }`) or a cached {@link WorldActor}.
 * Returns undefined when no system object is present (e.g. the mapped
 * {@link FoundryActor} produced by the socket world-cache path).
 */
function systemOf(obj: unknown): Record<string, unknown> | undefined {
  if (isRecord(obj) && isRecord(obj.system)) {
    return obj.system;
  }
  return undefined;
}

/**
 * Compendium pagination cursors are opaque base64-encoded result offsets.
 * `encodeCursor` turns an offset into a cursor; `decodeCursor` reads it back,
 * returning 0 when the cursor is absent or malformed.
 */
function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64');
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) {
    return 0;
  }
  const decoded = Number.parseInt(Buffer.from(cursor, 'base64').toString('utf8'), 10);
  return Number.isFinite(decoded) && decoded >= 0 ? decoded : 0;
}

function extractNested(obj: Record<string, unknown>, ...keys: string[]): unknown {
  let current: unknown = obj;
  for (const key of keys) {
    if (isRecord(current) && key in current) {
      current = current[key];
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * Extracts a string from nested Record, following a chain of keys.
 */
function extractString(obj: Record<string, unknown>, ...keys: string[]): string | null {
  const val = extractNested(obj, ...keys);
  return typeof val === 'string' ? val : null;
}

// ============================================================================
// Attribute-patch helpers (laurigates/foundryvtt-mcp#143)
// ============================================================================

/**
 * Reads a dot-path out of a nested Record tree, returning undefined if any
 * segment is missing.
 */
function getDotPath(obj: Record<string, unknown>, path: string): unknown {
  return extractNested(obj, ...path.split('.'));
}

/**
 * Reads the actor's game-system id from raw world data, when available.
 * Used to pick the exhaustion clamp (2024 dnd5e: 0–10; 2014: 0–6).
 */
function exhaustionMax(sys: Record<string, unknown> | undefined): number {
  // dnd5e 2024 rules cap exhaustion at 10; the 2014 rules cap it at 6.
  // Without an explicit rules-version signal, default to the wider 2024 range
  // so legitimate 2024 values are not rejected; the 2014 cap is applied when
  // the actor's system data exposes a `rules: "2014"`-style marker.
  if (isRecord(sys)) {
    const source = isRecord(sys._source) ? sys._source : undefined;
    const rules =
      extractString(sys, 'rules') ||
      (source ? extractString(source, 'rules') : null) ||
      extractString(sys, 'attributes', 'exhaustion', 'rules');
    if (rules === '2014' || rules === 'legacy') {
      return 6;
    }
  }
  return 10;
}

/**
 * Validates an attribute patch against the actor's current data, throwing a
 * clear error on the first violation. Only checks rules for which the needed
 * limit (max HP, slot max, exhaustion bound) is available.
 */

function validateAttributePatch(
  patch: AttributePatch,
  actor: FoundryActor,
  rawSystem: Record<string, unknown> | undefined,
): void {
  // Prefer the raw `system` document for bounds: in REST mode getActor returns
  // the raw document (HP at system.attributes.hp.{value,max,temp}); the mapped
  // FoundryActor.hp is only populated on the socket world-cache path.
  const rawHp = rawSystem ? extractNested(rawSystem, 'attributes', 'hp') : undefined;
  const hp = isRecord(rawHp) ? rawHp : undefined;

  for (const [path, value] of Object.entries(patch)) {
    // HP value cannot exceed max + temp.
    if (path === 'attributes.hp.value' && typeof value === 'number') {
      const patchedTemp = patch['attributes.hp.temp'];
      const currentTemp = typeof hp?.temp === 'number' ? hp.temp : (actor.hp?.temp ?? 0);
      const temp = typeof patchedTemp === 'number' ? patchedTemp : currentTemp;
      const max = typeof hp?.max === 'number' ? hp.max : actor.hp?.max;
      if (typeof max === 'number' && value > max + temp) {
        throw new Error(
          `Invalid HP value ${value}: exceeds max + temp (${max} + ${temp} = ${max + temp})`,
        );
      }
    }

    // Spell-slot value cannot exceed its max.
    const slotMatch = /^spells\.(spell\w+|pact)\.value$/.exec(path);
    const slotKey = slotMatch?.[1];
    if (slotKey && typeof value === 'number' && rawSystem) {
      const slotMax = extractNested(rawSystem, 'spells', slotKey, 'max');
      if (typeof slotMax === 'number' && value > slotMax) {
        throw new Error(
          `Invalid spell slot value ${value} for ${slotKey}: exceeds max (${slotMax})`,
        );
      }
    }

    // Exhaustion clamped 0–10 (2024) or 0–6 (2014).
    if (path === 'attributes.exhaustion' && typeof value === 'number') {
      const max = exhaustionMax(rawSystem);
      if (value < 0 || value > max) {
        throw new Error(`Invalid exhaustion ${value}: must be between 0 and ${max}`);
      }
    }
  }
}
