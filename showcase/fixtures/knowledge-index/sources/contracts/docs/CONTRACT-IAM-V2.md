---
id: CONTRACT-IAM-V2
kind: spec
status: ACTIVE
version: "2.0.0"
owner: team-iam
authority: intent
describes: ["contract:iam-v2"]
x-fe:
  appliesTo: { contracts: { iam: "2.0.0" } }
  visibility: internal
---
# IAM API contract 2.0: session introspection

`POST /v2/sessions:introspect` returns a session resource with scopes.
