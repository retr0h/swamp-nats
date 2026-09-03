# Contributing

Thanks for contributing to `@retr0h/nats`.

This file is the single source for how work happens here. `AGENTS.md` and
`CLAUDE.md` point at it and carry only what is specific to agents; the README
describes what the extension does, not how to change it.

## Prerequisites

- **[mise](https://mise.jdx.dev/).** Provisions Deno from `.mise.toml`. The only
  dependency you install yourself:

  ```bash
  brew install mise
  ```

- **[swamp](https://swamp-club.com).** The CLI this extension is built for.
  Authenticate once with `swamp auth login`.

Swamp bundles its own Deno at `~/.swamp/deno/deno`. It is not on `PATH`, and it
is the one the bundler uses, so type-check with it rather than any Deno `mise`
provides.

## Setup

```bash
mise install
swamp extension source add "$PWD"    # register this extension locally
```

## Layout

```text
manifest.yaml                     name, version, and every file shipped
extensions/models/nats_host.ts    the model — schemas and methods
extensions/models/lib/            NATS client and wire protocol
```

## Imports

Always use `import { z } from "npm:zod@4";` — never a bare `from "zod"`. The
swamp-club scorer runs `deno doc --lint` in a hermetic sandbox that writes its
own `deno.json` with no imports map, so a bare specifier resolves locally and
fails at score time.

Pin explicit versions in every `npm:` specifier. Swamp's bundler inlines npm
packages into the bundle, so `deno.lock` does not cover them.

## Testing

```bash
~/.swamp/deno/deno check extensions/models/nats_host.ts
~/.swamp/deno/deno test --allow-read --allow-env extensions/models/
```

Unit tests use `createModelTestContext()` from
`jsr:@swamp-club/swamp-testing`. Cover both success and failure paths.

## Adversarial review

`swamp extension push` requires a review report bound to a content hash of the
source, so any change needs a fresh one.

```bash
swamp extension push manifest.yaml --dry-run --json    # prints path + skeleton
SWAMP_EXTENSION_REVIEW_DIR="$PWD/.swamp-review" \
  swamp extension push manifest.yaml --dry-run
```

Keep reports in `.swamp-review/` rather than the system temp directory a local
run defaults to, so they survive. **The override needs an absolute path**; a
relative one is ignored silently.

Run the mandatory mechanical checks before the dimensional review —
schema-write conformance in particular, which catches fields written to a
resource but never declared on its schema. The type checker does not see those.

Record an honest `issue` rather than arguing a dimension into `pass`. Issues
surface under a different ruleId than a missing review, so a CI gate still
passes while the note stays visible.

## Publishing

```bash
swamp extension version @retr0h/nats     # next CalVer
swamp extension fmt manifest.yaml
swamp extension push manifest.yaml --dry-run
swamp extension push manifest.yaml
```

## Before committing

```bash
swamp extension fmt manifest.yaml
~/.swamp/deno/deno test --allow-read --allow-env extensions/models/
```

## Branching

Develop on feature branches. Branch from `main` using `type/short-description`,
where `type` matches the [Conventional Commits](https://conventionalcommits.org)
type: `feat/add-stream-method`, `fix/reconnect-backoff`, `docs/update-readme`.

## Commit messages

Follow [Conventional Commits](https://conventionalcommits.org) with the 50/72
rule:

- **Subject**: max 50 characters, imperative mood, capitalised, no period
- **Body**: wrapped at 72 characters, separated from the subject by a blank line
- **Format**: `type(scope): description`
- **Types**: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`
- Summarise the what and the why, not the how

## Submitting a PR

- **Describe your changes.** A reviewer should not have to read the diff to
  learn why it exists.
- **Link previous work**, and say how this differs from it.
- **Draft PRs** for incomplete work you want to discuss; start the discussion in
  a comment so the description stays free to be rewritten.

## AI usage

All contributions are subject to the [AI Usage Policy](AI_POLICY.md). Disclose
the tool you used, and make sure you can explain what your change does without
the aid of AI tools.
