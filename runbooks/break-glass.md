# Break-glass

Use this only when the verify job cannot run. The record is `schemas/break-glass.schema.json`.

1. Two distinct GitHub logins sign the record. One login, or the same login twice, is rejected.
2. `expiresAt` is at most 24 hours after `activatedAt`.
3. `paths` must not match a control file (`CODEOWNERS`, `factory.yaml`, `factory.config.yaml`, workflows, `registry/**`, `package.json`).
4. Append the record under `runbooks/drills/` and keep it for two years.
5. Post-hoc verification is due 24 hours after `activatedAt`. If it does not finish, revert the change.

`evaluateBreakGlass` in `lib/break-glass.mjs` is the decision. The live drill does not claim two people approved it (DV-07).
