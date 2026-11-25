---
id: RUNBOOK-SESSION-0001
kind: runbook
status: ACTIVE
version: "4"
owner: team-admin-oncall
authority: procedure
describes: ["apps/admin/src/sessions/**"]
x-fe:
  visibility: restricted
  readers: [team-admin-oncall]
  indexOptIn: true
---
# Session handling incident runbook

Steps to revoke all sessions of a tenant during an incident. Restricted to the on-call group.
