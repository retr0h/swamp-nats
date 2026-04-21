// @retr0h/nats — wire protocol (Zod)
//
// Single source of truth for every message that crosses the NATS wire.
// The paired swamp-nats-agent vendors this file so both sides stay in
// lockstep — any protocol change surfaces as a TypeScript error at the
// import site on whichever side lags.
//
// Design decision: file-content primitives (writeFile, readFile) ALWAYS
// use JetStream Object Store. We don't split behavior by payload size —
// every transfer rides the bucket, period. Simpler wire protocol, simpler
// agent, and the ~few-ms overhead per small file is cheap compared to the
// complexity of a dual-path design.

import { z } from "npm:zod@4";

// ── Constants ────────────────────────────────────────────────────────────

/** JetStream object bucket used for all file transfers. */
export const OBJECT_BUCKET = "swamp-agent-files";

/** JetStream stream capturing all agent requests. */
export const REQUEST_STREAM = "SWAMP_AGENT";

/** JetStream stream capturing dead-letter messages. */
export const DLQ_STREAM = "SWAMP_AGENT_DLQ";

/** Subject prefix for DLQ messages. Deliberately outside `swamp.agent.>`
 *  so the DLQ stream can coexist with the request stream without JetStream
 *  refusing their subject sets as overlapping. */
export const DLQ_SUBJECT_PREFIX = "swamp.dlq";

// ── Shared primitives ────────────────────────────────────────────────────

export const BecomeSchema = z.object({
  become: z.boolean().default(false),
  becomeUser: z.string().optional(),
  becomePassword: z.string().optional(),
});
export type Become = z.infer<typeof BecomeSchema>;

/** Reference to content stored in JetStream Object Store. */
export const ObjectRefSchema = z.object({
  bucket: z.string().min(1),
  name: z.string().min(1),
  digest: z.string().optional(), // sha256 hex, for optional verification
  size: z.number().int().nonnegative().optional(),
});
export type ObjectRef = z.infer<typeof ObjectRefSchema>;

// ── Primitive: exec ──────────────────────────────────────────────────────

export const ExecRequestSchema = z.object({
  cmd: z.string().min(1),
  sudo: z.boolean().optional(),
  becomeUser: z.string().optional(),
  becomePassword: z.string().optional(),
  stdin: z.string().optional(),
  timeoutSec: z.number().int().positive().max(3600).optional(),
});
export type ExecRequest = z.infer<typeof ExecRequestSchema>;

export const ExecResponseSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int(),
  error: z.string().optional(),
});
export type ExecResponse = z.infer<typeof ExecResponseSchema>;

// ── Primitive: writeFile ─────────────────────────────────────────────────
// Content ALWAYS rides JetStream Object Store. The operator uploads bytes
// to a freshly-named object, then publishes this request with the ObjectRef.

export const WriteFileRequestSchema = z.object({
  path: z.string().min(1),
  sourceObject: ObjectRefSchema,
  mode: z.string().regex(/^0?[0-7]{3,4}$/).optional(),
  owner: z.string().optional(),
  group: z.string().optional(),
  sudo: z.boolean().optional(),
});
export type WriteFileRequest = z.infer<typeof WriteFileRequestSchema>;

export const WriteFileResponseSchema = z.object({
  ok: z.boolean(),
  bytesWritten: z.number().int().optional(),
  error: z.string().optional(),
});
export type WriteFileResponse = z.infer<typeof WriteFileResponseSchema>;

// ── Primitive: readFile ──────────────────────────────────────────────────
// Response ALWAYS returns an ObjectRef; the operator fetches bytes from
// Object Store.

export const ReadFileRequestSchema = z.object({
  path: z.string().min(1),
  sudo: z.boolean().optional(),
});
export type ReadFileRequest = z.infer<typeof ReadFileRequestSchema>;

export const ReadFileResponseSchema = z.object({
  sourceObject: ObjectRefSchema.optional(),
  error: z.string().optional(),
});
export type ReadFileResponse = z.infer<typeof ReadFileResponseSchema>;

// ── DLQ envelope ─────────────────────────────────────────────────────────
// When the agent hits an unrecoverable error it term()s the JetStream
// message and publishes this envelope to SWAMP_AGENT_DLQ.

export const DlqEnvelopeSchema = z.object({
  originalSubject: z.string(),
  hostname: z.string(),
  primitive: z.string().optional(),
  reason: z.enum([
    "schema_validation",
    "unknown_primitive",
    "max_deliver_exceeded",
    "internal_error",
  ]),
  error: z.string(),
  /** Base64-encoded original payload, for operator inspection. */
  originalPayload: z.string().optional(),
  timestamp: z.string(),
  deliveryAttempt: z.number().int().optional(),
});
export type DlqEnvelope = z.infer<typeof DlqEnvelopeSchema>;

// ── Primitive registry ───────────────────────────────────────────────────

export const PRIMITIVES = ["exec", "writeFile", "readFile"] as const;
export type Primitive = typeof PRIMITIVES[number];
