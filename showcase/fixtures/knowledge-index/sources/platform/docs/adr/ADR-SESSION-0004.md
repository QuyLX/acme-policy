---
id: ADR-SESSION-0004
kind: adr
status: DRAFT
version: "0.1"
owner: team-platform
authority: decision
describes: ["packages/server/src/session/**"]
x-fe:
  appliesTo: { packages: { "@platform/server": ">=2 <4" } }
  visibility: internal
---
# Session handling: keep session tokens in browser storage (draft)

Draft that conflicts with the ACTIVE decisions: tokens would be readable by scripts.
