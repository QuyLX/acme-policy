# Degraded mode

When the verify job does not publish a `VerificationRun`, the required check `verify` is unmet and a normal merge stops (SC-16 `verify-absent`).

Automatic switching to degraded mode is out of scope (FE §11.8). Someone turns the ruleset off only through the break-glass record in `break-glass.md`.

`bindings/github/ruleset.json` is the ruleset to apply. It is not applied yet: D-24 keeps `sec.secrets` failing on `acme-frontend`, so requiring `verify` would block every pull request to that repo.
