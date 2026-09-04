# Contributing

Thanks for improving Dynamic Task Router.

## Design constraints

Contributions must preserve these guarantees:

- A parent task owns the objective and final decision.
- Worker creation requires an explicit user request.
- Shared implementation contracts have one writer.
- Status and handoff report evidence, not assumptions.
- Abort is honest about whether the host actually stopped a child task.
- Critical work fails closed without safety boundaries and verification.

## Development

1. Make a focused change.
2. Keep worker I/O to the five-field contract in `core/routing-contract.md`.
3. Keep host-neutral behavior in `core/` and host controls in its package.
   Qwen task targets may use `fast`, inherited models, or user-configured model
   grades, but do not hard-code credentials or a provider-specific model ID in
   the extension.
   The sequential Ollama fallback must retain explicit exclusivity, advisory
   output only, and model unloading by default.
4. Run the relevant validator listed in [docs/RELEASING.md](docs/RELEASING.md).
5. Include validation evidence in the pull request.

Do not add host-specific internal tool names as hard requirements unless they
are part of a documented public interface.
