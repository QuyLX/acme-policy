---
id: ADR-SESSION-0002
kind: adr
status: ACTIVE
version: "2"
owner: team-platform
authority: decision
describes: ["packages/server/src/session/**"]
x-fe:
  appliesTo: { packages: { "@platform/server": ">=2 <3" } }
  visibility: internal
---
# Session handling: signed cookie sessions with absolute expiry (@platform/server 2.x)

Session handling in 2.x uses a signed, HTTP-only cookie with an absolute expiry of 8 hours.
