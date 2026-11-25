---
id: ADR-SESSION-0003
kind: adr
status: ACTIVE
version: "1"
owner: team-platform
authority: decision
describes: ["packages/server/src/session/**"]
x-fe:
  appliesTo: { packages: { "@platform/server": ">=3 <4" } }
  visibility: internal
---
# Session handling: server-side sessions with sliding expiry (@platform/server 3.x)

Sessions are stored server-side and renewed on activity.
