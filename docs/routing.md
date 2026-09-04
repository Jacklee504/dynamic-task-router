# Routing and fan-out

Use the runtime only for an explicit bounded task. The lead still owns task
decomposition, integration, and final verification.

```sh
npm run dtr -- select --role reviewer --complexity difficult --risk high
npm run dtr -- start
npm run dtr -- route --task "Find why valid signals never reach order submission; identify the failing handoff and check its focused test." --files "src/signals.ts,src/orders.ts,test/orders.test.ts"
npm run dtr -- fanout --families 2 --role debugger --risk high --prompt "Find why valid signals never reach order submission"
```

Useful profile flags are `--complexity`, `--risk`, `--diversity`,
`--prefer-local`, `--local-only`, `--privacy-sensitive`, `--requires-tools`,
`--private-code`, `--no-remote`, and `--context huge`. `--families 2` asks
fan-out for two independent model families; providers run concurrently when
eligible and each receives the same compact prompt only. The caller receives
separate results and performs any comparison.

`dtr route` refuses a multi-family requirement: use `dtr fanout` instead.
Codex and Claude routes have verified read-only modes; API routes cannot write
the checkout. Antigravity is an advisory exception: it is sandboxed but its CLI
does not offer DTR a verified read-only switch, so use a trusted checkout or an
isolated worktree. All commands write only optional metadata under DTR's
private temporary state directory.

Private-code, local-only, provider, and family restrictions are hard filters:
the selector fails rather than relaxing them. Cost preference is applied only
after those constraints. See [privacy](privacy.md) and [cost routing](cost-routing.md).

Normal `dtr route` dispatches reject task text over 100 words or 1,000
characters, accept at most eight relative file paths, and never attach file
content. The concise returned handoff is capped at 1,200 characters. Use
`dtr run --allow-raw-prompt` only when deliberately bypassing that normal
contract for an explicit provider/model invocation.
