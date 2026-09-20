# Providers

The runtime has seven adapters: authenticated local `codex` and `claude` CLIs,
the account-backed Google Antigravity (`agy`) CLI, local Ollama through Codex
OSS mode, OpenCode's configured model catalog, optional OpenRouter, and hosted Featherless. The CLI adapters use
their host's existing login. Ollama never downloads a model. OpenRouter and
Featherless support text-only advisory tasks.

## Google Antigravity (Gemini plan)

If `agy models` succeeds in the same Terminal that launches `dtr`, the
Antigravity entries in `config/models.yaml` become available automatically. No
Gemini API key is used or stored. DTR asks `agy models` for the account-specific
catalogue and only exposes listed model slugs; `dtr doctor --verbose` shows the
command check.

```sh
agy                 # one-time interactive sign-in with the Google AI plan account
agy models
dtr models
dtr route --provider antigravity --task "Review the named parser error path and identify the focused check." --files "src/parser.ts,test/parser.test.ts"
```

Antigravity runs in its own `--sandbox` mode. Its current CLI does **not**
provide DTR with a verified read-only permission switch comparable to Codex's
`read-only` sandbox or Claude's `plan` mode. The adapter therefore keeps
`write_safe: false` and instead exposes `worktreeScopedWrite`: an explicit
write pipeline in isolated or branch mode with a non-root scope may use
Antigravity inside a DTR worktree. It is never eligible for in-place writes.
DTR rejects commits, deletes, renames, and out-of-scope diffs, then leaves
integration to the parent. Do not treat this as a hard filesystem boundary.
`--private-code`, `--no-remote`, and `--local-only` exclude it.

If Terminal can run `agy` but `dtr doctor` cannot find it, start DTR from that
same shell or set the non-secret command-path variable before launching DTR:

```sh
export DTR_ANTIGRAVITY_COMMAND="/absolute/path/to/agy"
```

For machines where Ollama cannot run alongside the parent host, the repository
also includes an optional [sequential Ollama fallback](ollama.md). It is not a
runtime provider: the user pauses or closes the conflicting host, sends one
compact packet to Ollama, then reopens the host to review the advisory result.

On macOS, DTR also discovers the CLI bundled with ChatGPT or Codex when `codex`
is absent from Terminal's `PATH`. If you use a non-standard CLI location, set
the non-secret shell variable `DTR_CODEX_COMMAND` to its full executable path
before launching DTR. DTR does not read `.env` files.

To use Featherless, create an API key in its dashboard and provide it only to
the DTR process as `FEATHERLESS_API_KEY`. The included
`featherless-qwen3-32b` entry uses `Qwen/Qwen3-32B`, is enabled, and is not
approved for private code. Verify availability with `dtr doctor` or `dtr
models`, then make an explicit compact route:

```sh
dtr route --provider featherless --task "Review the named parser error path and run its focused test." --files "src/parser.ts,test/parser.test.ts"
```

Use an operating-system credential launcher or an exported shell variable for
the process that starts DTR. The runtime reads that process credential only; it
does not read `.env` files, store credentials, print them, or place them in run
records. A missing credential leaves the provider unavailable. The same rule
applies to the optional OpenRouter provider.

## Free cloud inference

There is no durable, provider-independent “free cloud model” entitlement. DTR
includes two deliberately disabled OpenRouter templates: a fixed Qwen free
variant and `openrouter/free`, which lets OpenRouter choose from its changing
zero-cost pool. Enable only the entry you intend to use after creating an
OpenRouter key outside the repository. The free router is appropriate for
small, non-private advisory tasks; it has changing availability, rate limits,
and no fixed underlying model. DTR records the returned model identifier when
the API supplies one.

```sh
# Set this only in the shell or an operating-system credential launcher; never in the repo.
export OPENROUTER_API_KEY="…"
dtr route --provider openrouter --task "Summarize the named public error path." --files "src/errors.ts"
```

OpenRouter's free route is not eligible for private code and is never treated
as a reliable implementation worker. Its configuration is disabled by default
to prevent accidental remote calls. See [OpenRouter's free-router
documentation](https://openrouter.ai/docs/guides/routing/routers/free-router)
for its current limits and changing model pool.

`dtr models refresh` may fetch OpenRouter's public model catalog when a
credential is present. It writes only a cache in DTR's operating-system
temporary state directory; it never changes model configuration. Cached metadata older than
24 hours is marked stale. Catalog availability does not make a model eligible:
the reviewed local registry remains authoritative.

Remote-provider calls are deliberate, bounded task calls. Use
`--private-code` or `--no-remote` for material that must not leave the machine.
See [privacy](privacy.md) and [adding a provider](adding-a-provider.md).

Optional provider-specific instructions and their input-token budget are
configured through the [prompt policy](prompt-policy.md). They are bounded,
validated before dispatch, and never stored in DTR run records.

## OpenCode-configured providers

OpenCode is the bridge for providers you have already configured there, such
as Featherless or a custom OpenAI-compatible endpoint. DTR invokes the local
`opencode` CLI; it does not read OpenCode's configuration, auth storage, or
any `.env` file, and it never copies API keys.

```sh
opencode models
dtr opencode-models
dtr doctor --verbose
```

`dtr opencode-models` reports catalog identifiers in the exact
`provider/model` form that OpenCode accepts. Discovery alone cannot determine
quality, role suitability, privacy, or cost, so it intentionally does not
auto-add every OpenCode model to DTR routing. Add a reviewed profile for each
model you want DTR to select, using the personal-config workflow in the
[OpenCode guide](opencode.md).

DTR runs OpenCode with `opencode run --model … --format json` in bounded
task mode and never passes `--auto` or resumes a shared session. Current
OpenCode CLI versions do not give DTR a verified permission flag, and the DTR
adapter exposes no `worktreeScopedWrite` in this release, so OpenCode models
are not eligible as implementation providers for write pipelines. The adapter
passes explicitly selected native text attachments through repeated `--file`
arguments only when the context planner chooses attachment transport; ordinary
repository context stays as workspace path references.
