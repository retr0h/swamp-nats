// @retr0h/nats — NATS (JetStream) transport primitives
//
// Full-featured NATS client wrapping the three wire primitives exposed by
// swamp-nats-agent (exec, writeFile, readFile). Every file transfer rides
// JetStream Object Store; every request is captured in a JetStream stream
// for durability; replies travel over core NATS inbox.
//
// Consumers:
//   1. Direct use from workflows via the @retr0h/nats/host model.
//   2. Other extensions (e.g. a NATS-backed fork of @adam/cfgmgmt's
//      _lib/ssh.ts shim) that need transport primitives internally.

import { z } from "npm:zod@4";
import {
  connect,
  credsAuthenticator,
  type NatsConnection,
  nkeyAuthenticator,
} from "jsr:@nats-io/transport-deno@^3.0.0";
import { jetstream } from "jsr:@nats-io/jetstream@^3.0.0";
import { Objm } from "jsr:@nats-io/obj@^3.0.0";
import {
  type ExecRequest,
  ExecResponseSchema,
  OBJECT_BUCKET,
  type ObjectRef,
  type ReadFileRequest,
  ReadFileResponseSchema,
  type WriteFileRequest,
  WriteFileResponseSchema,
} from "./protocol.ts";

// ── Public types ─────────────────────────────────────────────────────────

export interface ConnectOpts {
  /** Target hostname — maps to the NATS subject suffix. */
  nodeHost: string;
  /** NATS server URL (comma-separated list also accepted). */
  natsUrl: string;
  /** Subject prefix; default "swamp.agent". */
  natsSubjectPrefix?: string;
  /** Per-request timeout in ms; default 60000. */
  timeoutMs?: number;
  /** Auth — supply whichever fields match your NATS cluster. */
  natsUser?: string;
  natsPass?: string;
  natsToken?: string;
  /** Path to a NATS creds file (user JWT + nkey). Read at connect time. */
  natsCredsPath?: string;
  /** nkey seed as a string (alternative to creds file). */
  natsNKeySeed?: string;
  natsTlsCaFile?: string;
  natsTlsCertFile?: string;
  natsTlsKeyFile?: string;
}

export interface NatsConn {
  target: string;
  prefix: string;
  timeoutMs: number;
  nc: NatsConnection;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
}

export interface BecomeOpts {
  become?: boolean;
  becomeUser?: string;
  becomePassword?: string;
}

export interface WriteFileOpts extends BecomeOpts {
  mode?: string;
  owner?: string;
  group?: string;
  /** Encoding of the supplied `content` string; always decoded into bytes
   *  before uploading to Object Store. */
  contentEncoding?: "utf8" | "base64";
}

// ── Connection pool ──────────────────────────────────────────────────────

const POOL_KEY = "__retr0h_nats_pool";
(globalThis as Record<string, unknown>)[POOL_KEY] =
  (globalThis as Record<string, unknown>)[POOL_KEY] ||
  new Map<string, Promise<NatsConnection>>();

function pool(): Map<string, Promise<NatsConnection>> {
  return (globalThis as Record<string, unknown>)[POOL_KEY] as Map<
    string,
    Promise<NatsConnection>
  >;
}

// ── Public API ───────────────────────────────────────────────────────────

export async function getConnection(opts: ConnectOpts): Promise<NatsConn> {
  validateHostnameTarget(opts.nodeHost);
  const p = pool();
  const key = poolKey(opts);
  let conn = p.get(key);
  if (!conn) {
    conn = connect({
      servers: opts.natsUrl.split(",").map((s) => s.trim()),
      name: `swamp-nats:${opts.nodeHost}`,
      reconnect: true,
      maxReconnectAttempts: 5,
      ...(await authOptions(opts)),
    });
    p.set(key, conn);
  }
  return {
    target: opts.nodeHost,
    prefix: opts.natsSubjectPrefix ?? "swamp.agent",
    timeoutMs: opts.timeoutMs ?? 60_000,
    nc: await conn,
  };
}

export async function natsExec(
  conn: NatsConn,
  command: string,
  opts?: { stdinData?: string; timeoutSec?: number },
): Promise<ExecResult> {
  const req: ExecRequest = {
    cmd: command,
    stdin: opts?.stdinData,
    timeoutSec: opts?.timeoutSec,
  };
  return await request(conn, "exec", req, ExecResponseSchema);
}

export async function natsExecSudo(
  conn: NatsConn,
  command: string,
  opts?: BecomeOpts & { stdinData?: string; timeoutSec?: number },
): Promise<ExecResult> {
  const req: ExecRequest = {
    cmd: command,
    sudo: !!opts?.become,
    becomeUser: opts?.becomeUser,
    becomePassword: opts?.becomePassword,
    stdin: opts?.stdinData,
    timeoutSec: opts?.timeoutSec,
  };
  return await request(conn, "exec", req, ExecResponseSchema);
}

/** Write file content via the agent's writeFile primitive. Content is
 *  uploaded to Object Store and the agent fetches it from there. */
export async function natsWriteFile(
  conn: NatsConn,
  remotePath: string,
  content: string,
  opts?: WriteFileOpts,
): Promise<void> {
  const encoding = opts?.contentEncoding ?? "utf8";
  const bytes = encoding === "base64"
    ? base64Bytes(content)
    : new TextEncoder().encode(content);
  const ref = await uploadToObjectStore(conn, bytes);
  const req: WriteFileRequest = {
    path: remotePath,
    sourceObject: ref,
    sudo: !!opts?.become,
    mode: opts?.mode,
    owner: opts?.owner,
    group: opts?.group,
  };
  const resp = await request(conn, "writeFile", req, WriteFileResponseSchema);
  if (!resp.ok) {
    throw new Error(
      `writeFile ${remotePath} failed: ${resp.error ?? "unknown error"}`,
    );
  }
}

/** Read file content via the agent's readFile primitive. The agent uploads
 *  bytes to Object Store and returns an ObjectRef; this function fetches
 *  and decodes. */
export async function natsReadFile(
  conn: NatsConn,
  remotePath: string,
  opts?: { sudo?: boolean; encoding?: "utf8" | "base64" },
): Promise<{ content: string; encoding: "utf8" | "base64" }> {
  const req: ReadFileRequest = {
    path: remotePath,
    sudo: opts?.sudo,
  };
  const resp = await request(conn, "readFile", req, ReadFileResponseSchema);
  if (resp.error) {
    throw new Error(`readFile ${remotePath} failed: ${resp.error}`);
  }
  if (!resp.sourceObject) {
    throw new Error(
      `readFile ${remotePath}: agent returned neither content nor error`,
    );
  }
  const bytes = await downloadFromObjectStore(conn, resp.sourceObject);
  return encodeBytes(bytes, opts?.encoding ?? "utf8");
}

export async function waitForAgent(
  conn: NatsConn,
  timeoutSec: number,
): Promise<true> {
  const deadline = Date.now() + timeoutSec * 1_000;
  const probeConn: NatsConn = { ...conn, timeoutMs: 3_000 };
  while (Date.now() < deadline) {
    try {
      const res = await natsExec(probeConn, "true", { timeoutSec: 3 });
      if (res.exitCode === 0) return true;
    } catch {
      // request timed out — agent not yet reachable
    }
    await sleep(3_000);
  }
  throw new Error(
    `agent for ${conn.target} not reachable via ${conn.prefix} after ${timeoutSec}s`,
  );
}

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export async function closeAll(): Promise<void> {
  const p = pool();
  for (const conn of p.values()) {
    try {
      (await conn).close();
    } catch {
      // best-effort
    }
  }
  p.clear();
}

// ── Internal plumbing ────────────────────────────────────────────────────

function validateHostnameTarget(target: string): void {
  if (target === "_all" || target === "_any" || target.startsWith("label:")) {
    throw new Error(
      `@retr0h/nats is single-target; received reserved selector "${target}". ` +
        `Use workflow forEach to iterate over hosts.`,
    );
  }
  if (!/^[A-Za-z0-9_\-.]+$/.test(target)) {
    throw new Error(`invalid hostname: ${target}`);
  }
}

function poolKey(opts: ConnectOpts): string {
  const authKey = opts.natsCredsPath ?? opts.natsToken ?? opts.natsUser ??
    (opts.natsTlsCertFile ?? "anon");
  return `${opts.natsUrl}::${authKey}`;
}

async function authOptions(
  opts: ConnectOpts,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};

  if (opts.natsCredsPath) {
    const creds = await Deno.readFile(opts.natsCredsPath);
    out.authenticator = credsAuthenticator(creds);
  } else if (opts.natsNKeySeed) {
    out.authenticator = nkeyAuthenticator(
      new TextEncoder().encode(opts.natsNKeySeed),
    );
  } else if (opts.natsToken !== undefined) {
    out.token = opts.natsToken;
  } else if (opts.natsUser !== undefined) {
    out.user = opts.natsUser;
    if (opts.natsPass !== undefined) out.pass = opts.natsPass;
  }

  if (opts.natsTlsCaFile || opts.natsTlsCertFile || opts.natsTlsKeyFile) {
    const tls: Record<string, unknown> = {};
    if (opts.natsTlsCaFile) tls.caFile = opts.natsTlsCaFile;
    if (opts.natsTlsCertFile) tls.certFile = opts.natsTlsCertFile;
    if (opts.natsTlsKeyFile) tls.keyFile = opts.natsTlsKeyFile;
    out.tls = tls;
  }

  return out;
}

async function request<T>(
  conn: NatsConn,
  primitive: string,
  payload: unknown,
  responseSchema: z.ZodType<T>,
): Promise<T> {
  const subject = `${conn.prefix}.${conn.target}.${primitive}`;
  const data = new TextEncoder().encode(JSON.stringify(payload));
  const msg = await conn.nc.request(subject, data, { timeout: conn.timeoutMs });
  const raw = JSON.parse(new TextDecoder().decode(msg.data));
  return responseSchema.parse(raw);
}

async function uploadToObjectStore(
  conn: NatsConn,
  bytes: Uint8Array,
): Promise<ObjectRef> {
  const js = jetstream(conn.nc);
  const objm = new Objm(js);
  const os = await objm.open(OBJECT_BUCKET);
  const name = `${conn.target}/${crypto.randomUUID()}`;
  const info = await os.putBlob({ name }, bytes);
  return {
    bucket: OBJECT_BUCKET,
    name,
    digest: info.digest,
    size: info.size,
  };
}

async function downloadFromObjectStore(
  conn: NatsConn,
  ref: ObjectRef,
): Promise<Uint8Array> {
  const js = jetstream(conn.nc);
  const objm = new Objm(js);
  const os = await objm.open(ref.bucket);
  const bytes = await os.getBlob(ref.name);
  if (bytes === null) {
    throw new Error(`object not found: ${ref.bucket}/${ref.name}`);
  }
  return bytes;
}

function base64Bytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function encodeBytes(
  bytes: Uint8Array,
  encoding: "utf8" | "base64",
): { content: string; encoding: "utf8" | "base64" } {
  if (encoding === "base64") {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return { content: btoa(binary), encoding };
  }
  return { content: new TextDecoder().decode(bytes), encoding };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
