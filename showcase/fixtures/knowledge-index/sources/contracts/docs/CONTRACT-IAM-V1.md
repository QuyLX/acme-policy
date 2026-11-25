---
id: CONTRACT-IAM-V1
kind: spec
status: ACTIVE
version: "1.4.0"
owner: team-iam
authority: intent
describes: ["contract:iam"]
x-fe:
  appliesTo: { contracts: { iam: "1.4.0" } }
  visibility: internal
---
# IAM API contract 1.4: session introspection

`POST /v1/sessions/introspect` returns the subject, tenant and expiry of a session.
