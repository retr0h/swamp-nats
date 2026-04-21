// @retr0h/nats — NATS (JetStream) transport primitives
//
// API shape deliberately mirrors adam/cfgmgmt's internal SSH library so the
// 35 cfgmgmt models can swap transports by changing a single import line.
// Function names and argument shapes match adam's lib exactly. SSH-specific
// fields on ConnectOpts (port, username, privateKeyPath, strictHostKeyChecking)
// are accepted and ignored so adam's existing connect(g) helpers compile
// unchanged. NATS-specific fields (natsUrl, auth, subject prefix) are
// additional optional fields the dispatcher or operator supplies.
//
// Extras beyond adam's SSH lib: readFile, waitForAgent — available for
// extensions that want the capability; cfgmgmt models don't use them today.

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

// ── Public types (mirror adam's _lib/ssh.ts shapes) ──────────────────────

/** Connection options. SSH-legacy fields are accepted but ignored; NATS
 *  fields are extra optional additions. */
export interface ConnectOpts {
  // SSH-era fields — adam's cfgmgmt models pass these. `host` is the only
  // one actually used by the NATS transport (maps to the subject suffix);
  // the rest are accepted for drop-in compatibility and silently ignored.
  host: string;
  port?: number;
  username?: string;
  privateKeyPath?: string;
  strictHostKeyChecking?: string;

  // NATS-specific fields. The dispatcher in a patched `_lib/ssh.ts` (or
  // the operator calling this lib directly) supplies these.
  natsUrl?: string;
  natsSubjectPrefix?: string;
  timeoutMs?: number;
  natsUser?: string;
  natsPass?: string;
  natsToken?: string;
  natsCredsPath?: string;
  natsNKeySeed?: string;
  natsTlsCaFile?: string;
  natsTlsCertFile?: string;
  natsTlsKeyFile?: string;
}

/** Opaque connection handle — callers pass it around but don't inspect it. */
export interface NatsConn {
  target: string;
  prefix: string;
  timeoutMs: number;
  nc: NatsConnection;
}

/** Matches adam's `ExecResult`. */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
}

/** Matches adam's `BecomeOpts`. */
export interface BecomeOpts {
  become?: boolean;
  becomeUser?: string;
  becomePassword?: string;
}

/** Extra args for writeFileAs (mirrors adam's). */
export interface WriteFileOpts extends BecomeOpts {
  mode?: string;
  owner?: string;
  group?: string;
  /** Encoding of the supplied `content`. Default "utf8". */
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

// ── Public API (matches adam's _lib/ssh.ts names) ────────────────────────

export async function getConnection(opts: ConnectOpts): Promise<NatsConn> {
  validateHostnameTarget(opts.host);
  const natsUrl = opts.natsUrl ?? Deno.env.get("SWAMP_NATS_URL");
  if (!natsUrl) {
    throw new Error(
      `@retr0h/nats: natsUrl not provided and SWAMP_NATS_URL env var not set`,
    );
  }
  const p = pool();
  const key = poolKey(natsUrl, opts);
  let conn = p.get(key);
  if (!conn) {
    conn = connect({
      servers: natsUrl.split(",").map((s) => s.trim()),
      name: `swamp-nats:${opts.host}`,
      reconnect: true,
      maxReconnectAttempts: 5,
      ...(await authOptions(opts)),
    });
    p.set(key, conn);
  }
  return {
    target: opts.host,
    prefix: opts.natsSubjectPrefix ?? "swamp.agent",
    timeoutMs: opts.timeoutMs ?? 60_000,
    nc: await conn,
  };
}

/** Run a shell command. Mirrors adam's `exec()`. */
export async function exec(
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

/** Run a shell command, optionally with sudo. Mirrors adam's `execSudo()`. */
export async function execSudo(
  conn: NatsConn,
  command: string,
  opts?: BecomeOpts & { stdinData?: string; timeoutSec?: number },
): Promise<ExecResult> {
  if (!opts?.become) return await exec(conn, command, opts);
  const req: ExecRequest = {
    cmd: command,
    sudo: true,
    becomeUser: opts.becomeUser,
    becomePassword: opts.becomePassword,
    stdin: opts.stdinData,
    timeoutSec: opts.timeoutSec,
  };
  return await request(conn, "exec", req, ExecResponseSchema);
}

/** Write file content (no sudo). Mirrors adam's `writeFile()`. */
export async function writeFile(
  conn: NatsConn,
  remotePath: string,
  content: string,
): Promise<void> {
  await writeFileAs(conn, remotePath, content);
}

/** Write file content, optionally with sudo. Mirrors adam's `writeFileAs()`. */
export async function writeFileAs(
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
      `writeFileAs ${remotePath} failed: ${resp.error ?? "unknown error"}`,
    );
  }
}

/** Copy a local file to the remote host (no sudo). Mirrors adam's `scpFile()`.
 *  Operator reads the local file, uploads bytes to JetStream Object Store,
 *  agent fetches and writes. No new agent primitive — same writeFile wire. */
export async function scpFile(
  conn: NatsConn,
  localPath: string,
  remotePath: string,
): Promise<void> {
  await scpFileAs(conn, localPath, remotePath);
}

/** Copy a local file to the remote host, optionally with sudo. Mirrors
 *  adam's `scpFileAs()`. */
export async function scpFileAs(
  conn: NatsConn,
  localPath: string,
  remotePath: string,
  opts?: BecomeOpts & { mode?: string; owner?: string; group?: string },
): Promise<void> {
  const bytes = await Deno.readFile(localPath);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const b64 = btoa(binary);
  await writeFileAs(conn, remotePath, b64, {
    ...opts,
    contentEncoding: "base64",
  });
}

/** Read file content. Bonus primitive not in adam's SSH lib. */
export async function readFile(
  conn: NatsConn,
  remotePath: string,
  opts?: BecomeOpts & { encoding?: "utf8" | "base64" },
): Promise<{ content: string; encoding: "utf8" | "base64" }> {
  const req: ReadFileRequest = {
    path: remotePath,
    sudo: !!opts?.become,
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

/** Poll the agent via a trivial `exec "true"` until reachable. Bonus. */
export async function waitForAgent(
  conn: NatsConn,
  timeoutSec: number,
): Promise<true> {
  const deadline = Date.now() + timeoutSec * 1_000;
  const probeConn: NatsConn = { ...conn, timeoutMs: 3_000 };
  while (Date.now() < deadline) {
    try {
      const res = await exec(probeConn, "true", { timeoutSec: 3 });
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

/** Shell escape helper. Matches adam's `shellEscape()`. */
export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Close every pooled NatsConnection. Matches adam's `closeAll()`. */
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

function poolKey(natsUrl: string, opts: ConnectOpts): string {
  const authKey = opts.natsCredsPath ?? opts.natsToken ?? opts.natsUser ??
    (opts.natsTlsCertFile ?? "anon");
  return `${natsUrl}::${authKey}`;
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
