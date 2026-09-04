# Providers

The runtime has six adapters: authenticated local `codex` and `claude` CLIs,
the account-backed Google Antigravity (`agy`) CLI, local Ollama through Codex
OSS mode, optional OpenRouter, and hosted Featherless. The CLI adapters use
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

Antigravity runs in its own `--sandbox` mode and DTR adds an inspect-only
instruction to advisory routes. Its current CLI does **not** provide DTR with a
verified read-only permission switch comparable to Codex's `read-only` sandbox
or Claude's `plan` mode. DTR therefore never selects it for write pipelines
(`write_safe: false`), but a normal advisory run still executes in the selected
checkout. Use a trusted checkout or an isolated worktree when invoking it; do
not treat it as a hard read-only boundary. `--private-code`, `--no-remote`, and
`--local-only` exclude it.

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
