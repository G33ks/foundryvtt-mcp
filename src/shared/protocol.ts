/**
 * @fileoverview Wire protocol between relays and the shared process.
 *
 * Newline-delimited JSON over a named pipe / Unix socket. The client opens
 * with a `hello`; once the server accepts it, the client sends `request`s and
 * the server answers each with a `response` carrying the same `id`. Several
 * requests may be in flight on one connection; responses arrive in
 * completion order.
 */

import { z } from 'zod';

/** Bumped on any incompatible change to the messages below. */
export const PROTOCOL_VERSION = 1;

/**
 * Guard against a peer streaming an unterminated line forever. Tool results
 * can be large (`capture_scene` returns a base64 image), so this is generous.
 */
export const MAX_LINE_BYTES = 256 * 1024 * 1024;

/** JSON-RPC style error codes for conditions the protocol itself raises. */
export const IpcErrorCode = {
  /** The shared process is shutting down and did not start this request. Safe to retry. */
  Draining: -32001,
  /** Malformed request. */
  InvalidRequest: -32600,
} as const;

export const HelloSchema = z.object({
  type: z.literal('hello'),
  protocol: z.number().int(),
  /** `relay` connections are checked for version/config and keep the process alive;
   *  `control` connections (`status`, `stop`) are not. */
  role: z.enum(['relay', 'control']),
  version: z.string(),
  configHash: z.string(),
  token: z.string(),
});
export type Hello = z.infer<typeof HelloSchema>;

export const HelloRejectReasonSchema = z.enum([
  'unauthorized',
  'protocol',
  'version',
  'config',
  'draining',
]);
export type HelloRejectReason = z.infer<typeof HelloRejectReasonSchema>;

export const HelloReplySchema = z.discriminatedUnion('ok', [
  z.object({ type: z.literal('hello'), ok: z.literal(true), pid: z.number(), version: z.string() }),
  z.object({
    type: z.literal('hello'),
    ok: z.literal(false),
    reason: HelloRejectReasonSchema,
    message: z.string(),
  }),
]);
export type HelloReply = z.infer<typeof HelloReplySchema>;

export const OpSchema = z.enum(['tool', 'resource', 'status', 'stop']);
export type Op = z.infer<typeof OpSchema>;

export const RequestSchema = z.object({
  type: z.literal('request'),
  id: z.number().int(),
  op: OpSchema,
  name: z.string().optional(),
  args: z.record(z.string(), z.unknown()).optional(),
});
export type IpcRequest = z.infer<typeof RequestSchema>;

export const IpcErrorSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type IpcError = z.infer<typeof IpcErrorSchema>;

export const ResponseSchema = z.union([
  z.object({ type: z.literal('response'), id: z.number(), result: z.unknown() }),
  z.object({ type: z.literal('response'), id: z.number(), error: IpcErrorSchema }),
]);
export type IpcResponse = z.infer<typeof ResponseSchema>;

/** Result of the `status` op. FoundryVTT fields are absent until the core is built. */
export const DaemonStatusSchema = z.object({
  pid: z.number(),
  version: z.string(),
  startedAt: z.string(),
  uptimeSeconds: z.number(),
  endpoint: z.string(),
  logFile: z.string(),
  relays: z.number(),
  inFlight: z.number(),
  writeQueue: z.number().optional(),
  startupError: z.string().nullable(),
  foundryConnected: z.boolean().optional(),
  bridge: z
    .object({ enabled: z.boolean(), port: z.number(), moduleConnected: z.boolean() })
    .optional(),
  headlessGm: z
    .object({ enabled: z.boolean(), active: z.boolean(), status: z.string().nullable() })
    .optional(),
});
export type DaemonStatus = z.infer<typeof DaemonStatusSchema>;

/** Result of the `stop` op. */
export const StopReplySchema = z.object({ stopping: z.literal(true), pid: z.number() });

/** Serialises one message as a protocol line. */
export function encodeLine(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Splits a byte stream into JSON values, one per line. Throws from `push`
 * on invalid JSON or an over-long line; the caller drops the connection.
 */
export class LineDecoder {
  private buffer = '';

  constructor(private readonly maxLineBytes: number = MAX_LINE_BYTES) {}

  push(chunk: Buffer | string): unknown[] {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const messages: unknown[] = [];
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        messages.push(JSON.parse(line));
      }
      newline = this.buffer.indexOf('\n');
    }
    if (this.buffer.length > this.maxLineBytes) {
      throw new Error(`IPC line exceeds ${this.maxLineBytes} bytes`);
    }
    return messages;
  }
}
