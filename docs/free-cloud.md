# Free cloud options

DTR treats free cloud capacity as an optional, low-assurance input to routing,
not as a replacement for an owned model subscription.

## Account-backed capacity

Google Antigravity is the preferred route when a Google AI plan already
includes access: its `agy` CLI uses the existing account login, provides local
workspace tools, and DTR discovers the models available to that account. It is
not a Gemini API key and cannot be used as an OpenAI-compatible API endpoint.

## Free API capacity

OpenRouter's `openrouter/free` is the only included generic free-API route.
It needs an API key but has zero token price. The provider randomly selects an
available free model, so it is appropriate only for short, non-private,
read-only advisory work. Its model availability and rate limits change; DTR
does not promise a particular model or quality level.

QwenCloud promotional quota, trial credits, and similar offers belong in a
separate optional API provider configuration. They are useful temporary
credits, but not a “free forever” routing tier. Featherless is also an API
credit provider, not a free route.

## Practical policy

1. Use the remaining subscription and Antigravity for dependable work.
2. Use OpenRouter free only for low-risk fallback research, summaries, and
   independent opinions.
3. Keep private code local or in providers explicitly approved for it.
4. Leave remote free entries disabled until a process-only credential exists.
5. Treat 429, 5xx, cold starts, and changing model identities as normal free
   tier failure modes; DTR should fall back or report a bounded failure.
