import { z } from "npm:zod@4";
import {
  closeAll,
  getConnection,
  natsExec,
  natsExecSudo,
  natsWriteFile,
  waitForAgent,
} from "./lib/nats.ts";

// Global arguments — NATS connection + auth, shared by every method
const NatsConnectionArgs = z.object({
  nodeHost: z.string().describe(
    "Target hostname (maps to NATS subject suffix)",
  ),
  natsUrl: z.string().describe("NATS server URL (nats://host:port)"),
  natsSubjectPrefix: z.string().default("swamp.agent").describe(
    "Subject prefix for multi-tenant namespace isolation",
  ),
  timeoutMs: z.number().default(60000).describe("Per-request timeout (ms)"),

  // Auth — supply whichever fields match your NATS cluster
  natsUser: z.string().optional().describe("User/pass auth — username"),
  natsPass: z.string().optional().meta({ sensitive: true }).describe(
    "User/pass auth — password",
  ),
  natsToken: z.string().optional().meta({ sensitive: true }).describe(
    "Static token auth",
  ),
  natsCredsPath: z.string().optional().describe(
    "Path to NATS creds file (user JWT + nkey, recommended)",
  ),
  natsNKeySeed: z.string().optional().meta({ sensitive: true }).describe(
    "nkey seed directly (alternative to creds file)",
  ),
  natsTlsCaFile: z.string().optional().describe("mTLS — CA certificate file"),
  natsTlsCertFile: z.string().optional().describe(
    "mTLS — client certificate file",
  ),
  natsTlsKeyFile: z.string().optional().describe("mTLS — client key file"),
});

// Per-method argument schemas
const ExecArgs = z.object({
  command: z.string().describe("Command to execute"),
  timeout: z.number().default(30).describe(
    "Enforced timeout in seconds (agent cancels via AbortSignal)",
  ),
  sudo: z.boolean().default(false).describe(
    "Wrap command in sudo on the agent",
  ),
  becomeUser: z.string().default("root").describe(
    "User to become when sudo is true",
  ),
  becomePassword: z.string().optional().meta({ sensitive: true }).describe(
    "Password for sudo -S (piped via stdin)",
  ),
  stdin: z.string().optional().describe("Data to pipe to command stdin"),
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
  sudo: z.boolean().default(false).describe(
    "Use install(1) atomic write as root on the agent",
  ),
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

function connectOpts(g: GlobalArgs) {
  return {
    nodeHost: g.nodeHost,
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

export const model = {
  type: "@retr0h/nats/host",
  version: "2026.04.20.1",
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
        const result = args.sudo
          ? await natsExecSudo(conn, args.command, {
            become: true,
            becomeUser: args.becomeUser,
            becomePassword: args.becomePassword,
            stdinData: args.stdin,
            timeoutSec: args.timeout,
          })
          : await natsExec(conn, args.command, {
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
        await natsWriteFile(conn, args.dest, args.content, {
          contentEncoding: args.contentEncoding,
          mode: args.mode,
          owner: args.owner,
          group: args.group,
          become: args.sudo,
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
      execute: async (args: z.infer<typeof WaitForConnectionArgs>, context) => {
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
export { closeAll };
