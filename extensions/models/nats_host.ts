import { z } from "npm:zod@4";
import {
  closeAll,
  exec,
  execSudo,
  getConnection,
  waitForAgent,
  writeFileAs,
} from "./lib/nats.ts";

// Global arguments — mirrors @adam/cfgmgmt's GlobalArgsSchema shape
// (nodeHost / nodeUser / nodePort / nodeIdentityFile / become / becomeUser /
// becomePassword) so a cfgmgmt-style workflow author can move between SSH
// and NATS transports without relearning the field names. NATS-specific
// connection and auth fields are added alongside.
const NatsConnectionArgs = z.object({
  // Target + SSH-era fields (SSH ones accepted and ignored for NATS, but
  // kept so the namespace stays aligned with @adam/cfgmgmt).
  nodeHost: z.string().describe(
    "Target hostname (maps to NATS subject suffix)",
  ),
  nodeUser: z.string().default("root").describe(
    "Agent-side user (SSH-era field, advisory)",
  ),
  nodePort: z.number().default(22).describe(
    "SSH port (ignored by NATS transport)",
  ),
  nodeIdentityFile: z.string().optional().describe(
    "SSH private key path (ignored by NATS transport)",
  ),

  // Sudo / become — transport-agnostic, same field names as @adam/cfgmgmt
  become: z.boolean().default(false).describe(
    "Run commands with sudo on the agent",
  ),
  becomeUser: z.string().default("root").describe(
    "User to become when sudo is true",
  ),
  becomePassword: z.string().optional().meta({ sensitive: true }).describe(
    "Password for sudo -S (piped via stdin)",
  ),

  // NATS-specific connection + auth fields
  natsUrl: z.string().describe("NATS server URL (nats://host:port)"),
  natsSubjectPrefix: z.string().default("swamp.agent").describe(
    "Subject prefix for multi-tenant namespace isolation",
  ),
  timeoutMs: z.number().default(60000).describe("Per-request timeout (ms)"),
  natsUser: z.string().optional().describe("NATS user/pass auth — username"),
  natsPass: z.string().optional().meta({ sensitive: true }).describe(
    "NATS user/pass auth — password",
  ),
  natsToken: z.string().optional().meta({ sensitive: true }).describe(
    "NATS static token auth",
  ),
  natsCredsPath: z.string().optional().describe(
    "Path to NATS creds file (user JWT + nkey, recommended)",
  ),
  natsNKeySeed: z.string().optional().meta({ sensitive: true }).describe(
    "NATS nkey seed (alternative to creds file)",
  ),
  natsTlsCaFile: z.string().optional().describe("mTLS — CA certificate file"),
  natsTlsCertFile: z.string().optional().describe(
    "mTLS — client certificate file",
  ),
  natsTlsKeyFile: z.string().optional().describe("mTLS — client key file"),
});

// Per-method argument schemas — minimal surface, matches @keeb/ssh's style.
// Sudo + become fields live on globalArguments (above) so they're declared
// once per definition and reused across every method call.
const ExecArgs = z.object({
  command: z.string().describe("Command to execute"),
  timeout: z.number().default(30).describe(
    "Enforced timeout in seconds (agent cancels via AbortSignal)",
  ),
  stdin: z.string().optional().describe("Data to pipe to the command's stdin"),
});

const UploadArgs = z.object({
  dest: z.string().describe("Remote destination path"),
  content: z.string().describe(
    "File content — UTF-8 string or base64-encoded bytes",
  ),
  contentEncoding: z.enum(["utf8", "base64"]).default("utf8").describe(
    "Encoding of content",
  ),
  mode: z.string().regex(/^0?[0-7]{3,4}$/).optional().describe(
    "File mode (octal, e.g. 0644)",
  ),
  owner: z.string().optional().describe("File owner"),
  group: z.string().optional().describe("File group"),
});

const WaitForConnectionArgs = z.object({
  timeout: z.number().default(60).describe("Timeout in seconds"),
});

const ResultSchema = z.object({
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  exitCode: z.number().optional(),
  command: z.string().optional(),
  host: z.string().optional(),
  dest: z.string().optional(),
  connected: z.boolean().optional(),
  success: z.boolean().optional(),
  error: z.string().optional(),
  bytesWritten: z.number().optional(),
  logs: z.string().optional(),
  timestamp: z.string(),
});

type GlobalArgs = z.infer<typeof NatsConnectionArgs>;

/** Build ConnectOpts from globalArguments, mapping adam-style node* fields
 *  to the lib's canonical field names. */
function connectOpts(g: GlobalArgs) {
  return {
    host: g.nodeHost,
    port: g.nodePort,
    username: g.nodeUser,
    privateKeyPath: g.nodeIdentityFile,
    natsUrl: g.natsUrl,
    natsSubjectPrefix: g.natsSubjectPrefix,
    timeoutMs: g.timeoutMs,
    natsUser: g.natsUser,
    natsPass: g.natsPass,
    natsToken: g.natsToken,
    natsCredsPath: g.natsCredsPath,
    natsNKeySeed: g.natsNKeySeed,
    natsTlsCaFile: g.natsTlsCaFile,
    natsTlsCertFile: g.natsTlsCertFile,
    natsTlsKeyFile: g.natsTlsKeyFile,
  };
}

/** Build BecomeOpts from globalArguments. */
function becomeOpts(g: GlobalArgs) {
  return {
    become: g.become,
    becomeUser: g.becomeUser,
    becomePassword: g.becomePassword,
  };
}

export const model = {
  type: "@retr0h/nats/host",
  version: "2026.04.21.1",
  resources: {
    "result": {
      description: "NATS operation result",
      schema: ResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  globalArguments: NatsConnectionArgs,
  methods: {
    exec: {
      description:
        "Run a command on the remote host via swamp-nats-agent. Returns stdout/stderr/exitCode without throwing on non-zero exit.",
      arguments: ExecArgs,
      execute: async (args: z.infer<typeof ExecArgs>, context) => {
        const g = context.globalArgs as GlobalArgs;
        const logs: string[] = [];
        const log = (m: string) => logs.push(m);

        const conn = await getConnection(connectOpts(g));
        log(
          `exec on ${g.nodeHost} via ${g.natsUrl}: ${
            args.command.length > 120
              ? args.command.slice(0, 120) + "..."
              : args.command
          }`,
        );
        const result = await execSudo(conn, args.command, {
          ...becomeOpts(g),
          stdinData: args.stdin,
          timeoutSec: args.timeout,
        });
        log(
          `done: exitCode=${result.exitCode} stdout=${result.stdout.length}B stderr=${result.stderr.length}B`,
        );

        const handle = await context.writeResource("result", "result", {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          command: args.command,
          host: g.nodeHost,
          error: result.error,
          logs: logs.join("\n"),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    upload: {
      description:
        "Write file content to a remote path via swamp-nats-agent. Supports UTF-8 and base64 encoded content; atomic write under sudo via install(1).",
      arguments: UploadArgs,
      execute: async (args: z.infer<typeof UploadArgs>, context) => {
        const g = context.globalArgs as GlobalArgs;
        const logs: string[] = [];
        const log = (m: string) => logs.push(m);

        const conn = await getConnection(connectOpts(g));
        log(
          `upload ${args.content.length}B (${args.contentEncoding}) → ${g.nodeHost}:${args.dest}`,
        );
        await writeFileAs(conn, args.dest, args.content, {
          ...becomeOpts(g),
          mode: args.mode,
          owner: args.owner,
          group: args.group,
          contentEncoding: args.contentEncoding,
        });
        log("upload complete");

        const handle = await context.writeResource("result", "result", {
          dest: args.dest,
          host: g.nodeHost,
          success: true,
          bytesWritten: args.content.length,
          logs: logs.join("\n"),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    waitForConnection: {
      description:
        "Poll the swamp-nats-agent on the target host until it replies or timeout elapses.",
      arguments: WaitForConnectionArgs,
      execute: async (
        args: z.infer<typeof WaitForConnectionArgs>,
        context,
      ) => {
        const g = context.globalArgs as GlobalArgs;
        const logs: string[] = [];
        const log = (m: string) => logs.push(m);

        const conn = await getConnection(connectOpts(g));
        log(
          `waiting for agent ${g.nodeHost} via ${g.natsUrl} (up to ${args.timeout}s)`,
        );
        await waitForAgent(conn, args.timeout);
        log("agent is reachable");

        const handle = await context.writeResource("result", "result", {
          connected: true,
          host: g.nodeHost,
          logs: logs.join("\n"),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};

// Re-export closeAll so swamp can tear down the connection pool at exit.
// Also re-export `exec` — unused internally (execSudo covers both paths)
// but handy for external callers that want the no-sudo variant directly.
export { closeAll, exec };
