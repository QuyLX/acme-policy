# AGENTS.md — acme-policy

- Every file in this repo is a control file: changes need approval from a code owner of this repo and the Factory owner
  for trusted mechanisms (Standard §9.10).
- A new or changed check MUST ship with fixtures that fail on a violation and pass on a clean change, and with a test.
- Loosening a check (lower enforcement, narrower globs, removed rule) is a High-tier change; say so in the PR.
- `NOT_ASSESSED` and `ERROR` are never `PASS`. Evidence from a `local` executor never satisfies a required check.
- English only. Run `pnpm test` before proposing any change.
