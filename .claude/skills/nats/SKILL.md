---
name: nats
description: Run remote commands, upload files, and wait for NATS agent reachability with the @retr0h/nats extension. Use when wiring NATS operations into swamp workflows or models — exec shell commands on a host via the swamp-nats-agent daemon, write a file with `upload`, or block until an agent is online with `waitForConnection`. Triggers on "nats exec", "nats upload", "wait for nats agent", "remote command over nats", "@retr0h/nats", "nats/host model", "jetstream transport", or when composing workflows with cfgmgmt over NATS instead of SSH.
---

# @retr0h/nats

General-purpose NATS transport for swamp. Pairs with `swamp-nats-agent`,
a daemon that runs on every managed host and answers three domain-agnostic
primitives (`exec`, `writeFile`, `readFile`) over a NATS subject scheme.

Where `@keeb/ssh` uses `ssh` / `scp` binaries to reach targets, `@retr0h/nats`
uses NATS request-reply — trading agentless SSH simplicity for persistent
subscribed fleet semantics (JetStream durability, offline-host catchup, label
routing, namespace isolation).

## Model: `@retr0h/nats/host`

Single model. All methods share connection arguments via `globalArguments`.

### Global arguments

| Field               | Type    | Default          | Notes                                               |
| ------------------- | ------- | ---------------- | --------------------------------------------------- |
| `nodeHost`          | string  | required         | Target hostname — maps to the NATS subject suffix   |
| `natsUrl`           | string  | required         | NATS server URL (`nats://host:port`)                |
| `natsSubjectPrefix` | string  | `swamp.agent`    | Override for multi-tenant namespace isolation       |
| `timeoutMs`         | number  | `60000`          | Per-request timeout in milliseconds                 |
| `natsUser`          | string  | optional         | User/pass auth — username                           |
| `natsPass`          | string  | optional         | User/pass auth — password (sensitive)               |
| `natsToken`         | string  | optional         | Static token auth (sensitive)                       |
| `natsCredsPath`     | string  | optional         | Path to NATS creds file (user JWT + nkey, recommended) |
| `natsNKeySeed`      | string  | optional         | nkey seed directly (sensitive, alternative to creds) |
| `natsTlsCaFile`     | string  | optional         | mTLS — CA certificate file                          |
| `natsTlsCertFile`   | string  | optional         | mTLS — client certificate file                      |
| `natsTlsKeyFile`    | string  | optional         | mTLS — client key file                              |

Authentication fields are mutually compatible — configure whichever your NATS
cluster requires. All secret-bearing fields are marked `sensitive: true` and
should be populated via vault references:

```yaml
natsCredsPath: ${{ vault.nats_ops.creds_path }}
natsNKeySeed: ${{ vault.nats_ops.nkey_seed }}
natsPass: ${{ vault.nats_ops.password }}
```

### Methods

#### `exec`

Run a shell command on the remote host via the `swamp-nats-agent` daemon.
Returns stdout, stderr, and exit code. The model method does NOT throw on
non-zero exit — callers inspect `result.exitCode` directly. This matches the
semantics cfgmgmt-style check/apply frameworks expect from their transport
library (adam's `_lib/ssh.ts exec`/`execSudo` also don't throw).

| Argument          | Type   | Default | Notes                                                |
| ----------------- | ------ | ------- | ---------------------------------------------------- |
| `command`         | string | —       | Command to execute                                   |
| `timeout`         | number | `30`    | Seconds — enforced by the agent via AbortSignal      |
| `sudo`            | bool   | `false` | Wrap command in `sudo -n` (or `sudo -S`) on the agent |
| `becomeUser`      | string | `root`  | User to become when `sudo: true`                     |
| `becomePassword`  | string | —       | Password for `sudo -S` (sensitive)                   |
| `stdin`           | string | —       | Piped to the command's stdin                         |

Result resource fields: `stdout`, `stderr`, `exitCode`, `command`, `host`,
`error?`, `logs`, `timestamp`.

#### `upload`

Write file content to a path on the remote host. Supports UTF-8 and base64
(for binary content like certificates, archives). Atomic write under sudo
via `install(1)` on the agent side.

| Argument          | Type   | Default | Notes                                                |
| ----------------- | ------ | ------- | ---------------------------------------------------- |
| `dest`            | string | —       | Remote path                                          |
| `content`         | string | —       | File content — UTF-8 string or base64-encoded bytes  |
| `contentEncoding` | enum   | `utf8`  | `utf8` or `base64`                                   |
| `mode`            | string | —       | Octal mode (e.g. `0644`)                             |
| `owner`           | string | —       | File owner                                           |
| `group`           | string | —       | File group                                           |
| `sudo`            | bool   | `false` | Use `install(1)` atomic write as root                |

Result fields: `dest`, `host`, `success`, `bytesWritten`, `logs`, `timestamp`.

#### `waitForConnection`

Polls the agent every 3s (via a trivial `exec "true"`) until reply succeeds or
`timeout` elapses. Throws if the agent never becomes reachable.

| Argument  | Type   | Default | Notes      |
| --------- | ------ | ------- | ---------- |
| `timeout` | number | `60`    | In seconds |

Result fields: `connected: true`, `host`, `logs`, `timestamp`.

## Resource

One resource type: `result` — `lifetime: infinite`, `garbageCollection: 10`
(retains the last 10 versions). All three methods write a single `result`
handle.

## Workflow patterns

### Provision then exec

```yaml
jobs:
  bootstrap:
    steps:
      - id: wait
        model: "@retr0h/nats/host"
        method: waitForConnection
        globalArguments:
          nodeHost: "${{ inputs.host }}"
          natsUrl: "nats://nats.internal:4222"
          natsCredsPath: "${{ vault.nats_ops.creds_path }}"
        arguments:
          timeout: 300

      - id: install
        model: "@retr0h/nats/host"
        method: exec
        needs: [wait]
        globalArguments:
          nodeHost: "${{ inputs.host }}"
          natsUrl: "nats://nats.internal:4222"
          natsCredsPath: "${{ vault.nats_ops.creds_path }}"
          sudo: true
        arguments:
          command: "apt-get install -y nginx"
```

### Upload a config then restart a service

```yaml
- id: push-config
  model: "@retr0h/nats/host"
  method: upload
  globalArguments: &conn
    nodeHost: "${{ inputs.host }}"
    natsUrl: "nats://nats.internal:4222"
    natsCredsPath: "${{ vault.nats_ops.creds_path }}"
  arguments:
    dest: /etc/nginx/sites-available/default
    content: "${{ data.latest('config', 'nginx').attributes.conf }}"
    contentEncoding: utf8
    mode: "0644"
    owner: root
    group: root
    sudo: true

- id: reload
  model: "@retr0h/nats/host"
  method: exec
  needs: [push-config]
  globalArguments:
    <<: *conn
    sudo: true
  arguments:
    command: "systemctl reload nginx"
```

### Binary upload (certificate)

```yaml
- id: push-cert
  model: "@retr0h/nats/host"
  method: upload
  globalArguments:
    nodeHost: "${{ inputs.host }}"
    natsUrl: "nats://nats.internal:4222"
  arguments:
    dest: /etc/ssl/certs/company.crt
    content: "${{ vault.tls.cert_pem_base64 }}"
    contentEncoding: base64
    mode: "0644"
    sudo: true
```

## NATS server assumptions

- A reachable NATS server at `natsUrl`
- **JetStream enabled** — every request is captured in the `SWAMP_AGENT`
  stream and every file transfer rides the `swamp-agent-files` Object Store
  bucket. Both auto-created by the agent on first startup.
- Operator credentials authorized to `pub` on `{natsSubjectPrefix}.>` and
  read/write access to the `swamp-agent-files` Object Store bucket
- `swamp-nats-agent` subscribed on the target host

See the extension's [README](../../../README.md) for the full server-side
configuration guide.

## Using from another extension (library mode)

Other extensions can import the transport lib directly without going through
the model/workflow layer — mirroring how cfgmgmt's `_lib/ssh.ts` exposes SSH
to 35 cfgmgmt models. Import from
`extensions/models/lib/nats.ts`:

```typescript
import {
  closeAll,
  getConnection,
  natsExec,
  natsExecSudo,
  natsReadFile,
  natsWriteFile,
  shellEscape,
  waitForAgent,
} from "path/to/lib/nats.ts";

const conn = await getConnection({
  nodeHost: "web-01",
  natsUrl: "nats://nats.internal:4222",
  natsCredsPath: "/etc/nats/ops.creds",
});
const result = await natsExecSudo(conn, "systemctl restart nginx", {
  become: true,
});
if (result.exitCode !== 0) { /* handle */ }
```

The lib functions intentionally mirror the shape of adam/cfgmgmt's
`_lib/ssh.ts` (same argument names, same `ExecResult` return shape, same
check/apply-friendly semantics — no throws on non-zero exit) so a cfgmgmt-
style extension can swap transports by changing one import line.

## Gotchas

- **Agent must be deployed.** Unlike `@keeb/ssh`, this is not agentless —
  every target host runs `swamp-nats-agent`. Plan for fleet bootstrapping.
- **File transfers always ride Object Store.** Even small files. Tiny extra
  latency (a put + get round-trip) vs SSH's single `scp` hop, bought for
  protocol simplicity and no 1 MiB ceiling. Large archives and binary
  blobs work without any special handling.
- **`exec` does NOT throw on non-zero exit** — whether called as a model
  method from a workflow or via the transport library from another
  extension. Always inspect `exitCode`. Inspect `exitCode` — behavior
  differs from `@keeb/ssh/exec` which throws. Matches the semantics cfgmgmt
  and similar check/apply frameworks expect.
- **Sudo wrapping is agent-side.** The agent runs `sudo -n` (or `sudo -S` with
  a piped password) locally; operators never construct sudo command strings.
- **No host key / fingerprint concept.** Trust is established through the NATS
  server's authentication — nkeys, creds, or mTLS. Configure NATS ACLs
  carefully.
- **`natsUser` default is not `root`.** There is no default — omit NATS auth
  fields entirely for anonymous auth (trusted local env only), or supply
  whichever fields your cluster requires.
- **Timeout is enforced.** The agent cancels long-running commands via
  `AbortSignal` and reports `timeout after Ns` in the `error` field. No need
  to wrap in a remote `timeout(1)`.
