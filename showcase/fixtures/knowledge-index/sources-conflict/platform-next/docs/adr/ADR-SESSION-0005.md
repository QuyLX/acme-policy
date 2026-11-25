---
id: ADR-SESSION-0005
kind: adr
status: ACTIVE
version: "1"
owner: team-identity
authority: decision
describes: ["packages/server/src/session/**"]
x-fe:
  appliesTo: { packages: { "@platform/server": ">=2 <3" } }
  visibility: internal
---
# Session handling: sessions in a shared server store (@platform/server 2.x)

Approved by another team for the same 2.x line, without superseding ADR-SESSION-0002.
