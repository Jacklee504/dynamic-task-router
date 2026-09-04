# Evals and outcomes

Run the version-controlled routing fixtures without inference:

```sh
npm run dtr -- evaluate
npm run dtr -- stats
```

Fixtures assert routing properties such as local privacy handling, minimum
effort, independent review families, read-only constraints, tool access,
huge-context capability, private-code approval, and allowed provider/family
constraints. They do not invoke a model or depend on local CLI authentication.

Add a fixture whenever a policy change is proposed or a real task reveals a
misroute. Assert the necessary capability or safety property rather than a
particular model unless that exact choice is intentional; this lets model scores
evolve without turning the suite into an arbitrary model ranking.

Record a human review through `dtr outcome` after a run. After 20 reviewed
outcomes, stats may suggest inspecting routing priors; it never auto-tunes,
rewrites YAML, or sends telemetry externally.
