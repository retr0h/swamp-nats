[![build](https://img.shields.io/github/actions/workflow/status/retr0h/swamp-nats/ci.yml?style=for-the-badge)](https://github.com/retr0h/swamp-nats/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-brightgreen.svg?style=for-the-badge)](LICENSE)
[![release](https://img.shields.io/github/release/retr0h/swamp-nats.svg?style=for-the-badge)](https://github.com/retr0h/swamp-nats/releases/latest)
[![swamp extension](https://img.shields.io/badge/swamp.club-%40retr0h%2Fnats-ff69b4?style=for-the-badge)](https://swamp.club/extensions/@retr0h/nats)
[![deno](https://img.shields.io/badge/deno-2.x-000000?style=for-the-badge&logo=deno&logoColor=white)](https://deno.com)
[![conventional commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-yellow.svg?style=for-the-badge)](https://conventionalcommits.org)
![commit activity](https://img.shields.io/github/commit-activity/m/retr0h/swamp-nats?style=for-the-badge)

# @retr0h/nats

🐊 [Swamp](https://github.com/systeminit/swamp) extension for general-purpose
NATS transport operations — remote command execution, file upload, and agent
reachability checks over a NATS (optionally JetStream) message bus.

Pairs with [swamp-nats-agent](https://github.com/retr0h/swamp-nats-agent), a
thin NATS-subscribed daemon that runs on every managed host and exposes three
domain-agnostic primitives (`exec`, `writeFile`, `readFile`).

Where [`@keeb/ssh`](https://github.com/keeb/swamp-ssh) talks to `sshd` via the
local `ssh`/`scp` binaries, `@retr0h/nats` talks to
[`swamp-nats-agent`](https://github.com/retr0h/swamp-nats-agent) via NATS
subjects. Same shape, different wire — trade agentless-SSH-simplicity for
persistent-subscribed-fleet with JetStream durability, label routing, and
namespace isolation.

## 📦 Models

### `nats/host`

Remote command execution, file upload, and agent reachability waiting over
NATS request-reply.

| Method              | Description                                             |
| ------------------- | ------------------------------------------------------- |
| `exec`              | Execute a command on the remote host                    |
| `upload`            | Write file content to a path on the remote host         |
| `waitForConnection` | Wait until the agent is reachable (request/reply probe) |

## 🔧 Workflows

None — this is a foundational model used by other extensions (for example, a
NATS-backed fork of cfgmgmt can patch its `_lib/ssh.ts` to import from here
instead of shelling out to `ssh`/`scp`).

## 🔗 Dependencies

None (at the swamp extension layer). At the operator layer you need a reachable
NATS server; at the host layer you need `swamp-nats-agent` subscribed.

## 👥 Used by

- [swamp-nats-agent](https://github.com/retr0h/swamp-nats-agent) — the
  companion daemon that runs on every managed host and answers the three
  primitives.

## 🎯 Upstreaming to @adam/cfgmgmt

The primary use case for this transport is as a **drop-in replacement** for
[@adam/cfgmgmt](https://swamp.club/extensions/@adam/cfgmgmt)'s internal
`_lib/ssh.ts`. Our library exports the same symbol names (`getConnection`,
`exec`, `execSudo`, `writeFile`, `writeFileAs`, `scpFile`, `scpFileAs`,
`shellEscape`, `closeAll`) with the same argument shapes, so adam's 35
cfgmgmt models can keep their existing import line and gain NATS transport
via a single-file dispatcher patch in cfgmgmt's repo.

### Planned upstream change

One file changes in `adamhjk/swamp-cfgmgmt` — `_lib/ssh.ts` becomes a
dispatcher:

```typescript
// proposed patched _lib/ssh.ts
import * as ssh from "./transport_ssh.ts";    // adam's current SSH code, renamed
import * as nats from "@retr0h/nats/lib";     // this extension

export const getConnection = (opts) =>
  opts.transport === "nats" ? nats.getConnection(opts) : ssh.getConnection(opts);
// ... same dispatch for execSudo, writeFileAs, scpFileAs, exec, writeFile, etc.
```

cfgmgmt's `GlobalArgsSchema` gains one new field (`transport: "ssh" | "nats"`,
default `"ssh"`) plus the NATS-specific connection fields (`natsUrl`,
`natsCredsPath`, etc.). The 35 domain models — `sysctl.ts`, `user.ts`,
`cron.ts`, `systemd.ts`, `file.ts`, etc. — stay byte-for-byte identical.

### Operator experience after the upstream lands

Per-definition opt-in:

```yaml
# SSH-mode definition — works today, no change
type: "@adam/cfgmgmt/sysctl"
globalArguments:
  nodeHost: web-01
  nodeUser: root
  nodeIdentityFile: ~/.ssh/ops
  key: net.ipv4.ip_forward
  value: "1"
```

```yaml
# NATS-mode definition — works after the upstream patch + @retr0h/nats install
type: "@adam/cfgmgmt/sysctl"
globalArguments:
  nodeHost: web-01
  transport: nats
  natsUrl: "nats://nats.internal:4222"
  natsCredsPath: "${{ vault.nats_ops.creds_path }}"
  key: net.ipv4.ip_forward
  value: "1"
```

Mixed-transport workflows (some definitions SSH, others NATS) in the same
repo are supported since the selector is per-definition.

## 📥 Install

```bash
swamp extension pull @retr0h/nats
```

Or for local development:

```bash
swamp extension source add ~/git/swamp.club/swamp-nats
```

## 🧰 NATS server assumptions

Unlike SSH (which "just works" wherever `sshd` is running), NATS transport
expects the following about your deployment:

### Required

- **A reachable NATS server.** URL passed via `natsUrl` on the model's
  globalArgs (e.g., `nats://nats.internal:4222`), or via vault reference.
- **Subject publish permissions** for the operator. The operator's NATS
  credentials must be authorized to `pub` on the configured subject prefix
  (default `swamp.agent.>`).

### Required (continued)

- **JetStream enabled** on the server. Every request is captured in the
  `SWAMP_AGENT` stream for durability (offline hosts catch up on reconnect),
  and every file transfer rides the `swamp-agent-files` Object Store bucket.
  Both are auto-created by the agent on first startup; operators only need
  to ensure `jetstream { }` is configured in `nats.conf`.

### Recommended

- **Subject-level ACLs** scoped per operator/tenant, so a compromise of one
  operator's credentials can't publish to every host in the fleet.

### Optional

- **Namespace prefix isolation** for multi-tenant deployments — set
  `natsSubjectPrefix` to something like `org.team.swamp.agent` and scope
  ACLs accordingly.

### Consumer config (agent side)

Consumer configuration (stream name, filter subject, ack policy, max deliver,
etc.) lives on the **agent** side, not in this extension. See the
[swamp-nats-agent README](https://github.com/retr0h/swamp-nats-agent) for
agent CLI flags and env vars. This extension only publishes requests and
awaits replies; it does not subscribe or manage consumers.

## 🔐 Authentication

Every NATS auth mechanism is exposed as globalArgs fields, mirroring how SSH
models expose `nodeUser`/`nodeIdentityFile`. Pass whichever fields match your
NATS cluster. Secret fields are marked `sensitive: true` so vault refs are
handled cleanly.

| Field                | Auth mode        | Notes                              |
| -------------------- | ---------------- | ---------------------------------- |
| *none*               | anonymous        | Use only in trusted local envs     |
| `natsUser` + `natsPass` | user/password | Classic password auth              |
| `natsToken`          | static token     | Pre-shared bearer token            |
| `natsCredsPath`      | user JWT + nkey  | NATS creds file (recommended)      |
| `natsNKeySeed`       | nkey only        | Pass the seed directly (vault ref) |
| `natsTlsCertFile` + `natsTlsKeyFile` | mTLS | Paired with `natsTlsCaFile` |

Use vault references for every secret-bearing field. Example:

```yaml
natsCredsPath: ${{ vault.nats_ops.creds_path }}
natsNKeySeed: ${{ vault.nats_ops.nkey_seed }}
```

## 🧑‍💻 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for prerequisites, setup, testing, the
adversarial review and publishing.

## 📄 License

The [MIT][] License.

[MIT]: LICENSE
