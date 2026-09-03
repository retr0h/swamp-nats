# AGENTS.md

Read @CONTRIBUTING.md first. It covers prerequisites, setup, the layout,
testing, the adversarial review and publishing. All of it applies to agents
exactly as it applies to people. This file carries only what is specific to
agents.

## Running tools

Invoke tools through `mise`, not from your path:

```bash
mise exec -- deno --version
```

`mise` is active in a person's shell and supplies the versions `.mise.toml`
declares. An agent's shell has no activation, so a bare `deno` resolves to
whatever is installed globally, usually an older version.

The one exception is Deno when type-checking extension code: swamp bundles its
own at `~/.swamp/deno/deno`, which is not on `PATH` and is the one the bundler
uses. Invoke it by full path.

## The swamp skills are the reference

The managed section above lists them. Load them rather than answering from
memory — the command surface moves, and some commands the older skills
documented no longer exist.

## Commit trailer

When committing via Claude Code, end the message with:

```
🤖 Generated with [Claude Code](https://claude.ai/code)

Co-Authored-By: Claude <noreply@anthropic.com>
```
