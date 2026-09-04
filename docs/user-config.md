# Personal router configuration

DTR loads an optional, key-free personal overlay from the path reported by:

```sh
dtr config
```

The default is `~/.config/dynamic-task-router/config.yaml`. Set the non-secret
`DTR_USER_CONFIG` shell variable to use a different file. DTR never reads an
`.env` file, and this schema rejects unknown fields, so credentials cannot be
stored in the overlay.

Use it for personal model enablement, routing-tier adjustments, and complete
profiles for models discovered through OpenCode. It does not modify the cloned
repository or target repositories.

```yaml
version: 1
models:
  overrides:
    - id: qwen-local
      enabled: false
    - id: codex-terra
      roles: { implementer: 10, reviewer: 9 }
  additions: []
```

An override may set only `enabled`, `tier`, role scores, supported efforts, or
the default effort. An addition must be a complete model profile. Unknown model
IDs, duplicate additions, unsupported effort combinations, and any
credential-shaped field fail closed.

See [OpenCode](opencode.md) for an addition template. Run `dtr models` after a
change to see the effective inventory.
