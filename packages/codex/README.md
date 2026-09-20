# Codex package

This is the Codex desktop adapter. It includes a visible-subchat workflow and
a Dynamic Task Router skill for bounded work routed through DTR's local MCP
server.

Install the `skills/app-task-router/` directory as a local skill, or package
this directory through the applicable Codex plugin distribution flow. Invoke
`$app-task-router` explicitly before creating subchats.

Install `skills/dynamic-task-router/` as a local skill after adding DTR's MCP
server. Invoke `$dynamic-task-router` when DTR should choose a configured
worker or pipeline. The skill keeps worker input and returned handoffs compact;
the parent still owns approval, integration, and verification.

The subchat task packet is intentionally six fields and ordinary returns are
limited to four lines and about 120 tokens. Detailed lifecycle guidance stays
in references so the parent loads it only when needed.
