# Privacy and remote routing

Use `--private-code` when the supplied prompt, paths, or source material may
be private. Use `--no-remote` or `--local-only` when it must remain local.
`--privacy-sensitive` also requires a local candidate. The selector rejects
remote models that do not explicitly allow private code; it does not silently
fall back to a remote provider.

Treat model privacy metadata as a reviewed policy decision, not marketing
copy. Before enabling a remote model, set its `privacy.private_code_allowed`
only after confirming the provider terms suitable for your data. Prompts and
model outputs are not stored; only selection and run metadata may be retained in
DTR's private operating-system temporary state directory.
