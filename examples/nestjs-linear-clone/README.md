# nestjs-linear-clone

A Linear/Jira-style issue tracker built on NestJS + [@stingerloom/orm](https://www.npmjs.com/package/@stingerloom/orm).
This example exists to demonstrate **production-grade SQL patterns** that the
simpler examples in this repo (`nestjs-blog`, `nestjs-cats`, `nestjs-todo`)
do not exercise.

## What this example showcases

| Capability | Where to look |
|---|---|
| Recursive CTE — subissue tree of any depth | `analytics.service.ts` `issueTree()` |
| Window functions — sprint burndown (SUM OVER) | `analytics.service.ts` `sprintBurndown()` |
| Window functions — assignee throughput rank (ROW_NUMBER) | `analytics.service.ts` `assigneeThroughput()` |
| Window functions — time-in-status (LAG/LEAD) | `analytics.service.ts` `timeInStatus()` |
| Aggregate windowing — weekly lead time | `analytics.service.ts` `leadTimeByWeek()` |
| Full-text search across two tables (UNION ALL) | `search.service.ts` `fullTextIssues()` |
| JSON custom-field key/value queries | `search.service.ts` `byCustomField()` |
| `FOR UPDATE SKIP LOCKED` worker queue | `queue.service.ts` `claimNext()` |
| Optimistic locking via `@Version` (409 on stale) | `issues.service.ts` `update()` |
| Soft delete (`@DeletedAt`) + restore | `issues.service.ts` `softRemove()`/`restore()` |
| ManyToMany via direct join-table SQL (driver-aware) | `issues.service.ts` `addLabel()`/`removeLabel()` |
| Audit log driven by service-side hook calls | `activity.service.ts` |
| Cursor pagination | `issues.service.ts` `findWithCursor()` |
| Dialect-portable raw SQL (MySQL + PostgreSQL) | `analytics/sql-helpers.ts` |

## Domain model

```
Workspace
   └─ Membership (User × Workspace, role)
   └─ Project (workspaceId, customFieldSchema JSON)
        ├─ Sprint
        ├─ Label
        └─ Issue
              ├─ parent_id (self-ref) — recursive tree
              ├─ @Version — optimistic lock
              ├─ customFields JSON — per-project custom fields
              ├─ FullTextIndex(title, description)
              ├─ ManyToMany Label
              └─ Comment (FullTextIndex(body))

ActivityLog (append-only) ← driven by IssuesService and CommentsService
```

## Run it

```bash
# Install (uses workspace:* link to the ORM source)
pnpm install

# Make sure a database is reachable. Defaults: MySQL on localhost:3306.
cp .env.example .env
# edit .env if needed; set DB_TYPE=postgres for PostgreSQL

# Boot — synchronize: true creates the schema on first run.
pnpm start:dev

# Populate sample data (workspace, users, project, sprint, ~14 issues with a 4-deep tree)
pnpm seed

# Open Swagger UI
open http://localhost:3000/api-docs
```

## Try the advanced endpoints

After seeding (workspace=1, project=1):

```bash
# Recursive subissue tree
curl http://localhost:3000/analytics/issues/1/tree

# Sprint burndown
curl http://localhost:3000/analytics/sprints/1/burndown

# Assignee throughput ranking
curl http://localhost:3000/analytics/projects/1/throughput

# Time-in-status using LAG over activity_log
curl http://localhost:3000/analytics/issues/2/time-in-status

# Full-text search
curl 'http://localhost:3000/search/issues?q=connection&projectId=1'

# JSON custom field
curl 'http://localhost:3000/search/by-custom-field?projectId=1&key=severity&value=S0'

# Worker queue — claim with SKIP LOCKED
curl -X POST -H 'content-type: application/json' \
  -d '{"workerId":"worker-1","projectId":1}' \
  http://localhost:3000/queue/claim

# Optimistic update — first call returns the issue, then update with the
# version, second call with the same version returns 409
ISSUE=$(curl -s http://localhost:3000/issues/1)
echo "$ISSUE"
```

## Concurrency demo

Run two terminals against the same project to see SKIP LOCKED in action:

```bash
# Terminal 1
for i in 1 2 3; do curl -X POST -H 'content-type: application/json' \
  -d '{"workerId":"w1","projectId":1}' http://localhost:3000/queue/claim; echo; done

# Terminal 2 (in parallel)
for i in 1 2 3; do curl -X POST -H 'content-type: application/json' \
  -d '{"workerId":"w2","projectId":1}' http://localhost:3000/queue/claim; echo; done
```

Each worker receives **distinct** issues without blocking on the other.

## e2e tests

```bash
# Standard suite (auth-aware)
INTEGRATION_TEST=true pnpm test:e2e

# Concurrency stress (50-worker SKIP LOCKED, 50-writer @Version conflict,
# soft-delete + restore + ManyToMany interaction)
INTEGRATION_TEST=true STRESS=true pnpm test:stress
```

Tests rely on a live database — set `DB_TYPE` / `DB_HOST` / `DB_NAME` env vars
or use the provided `.env`. Tests issue JWTs through `POST /auth/dev-token`
(gated by `AUTH_ALLOW_DEV_TOKEN=true`, which the test harness sets automatically).

## Production hardening (v2)

This example was upgraded from "ORM demo" to a production-shaped app:

- **JWT auth** (`@nestjs/jwt`, bcrypt-hashed passwords) protecting every
  endpoint by default — `@Public()` opts out (auth, health).
- **Workspace scoping** via `@WorkspaceScoped({ from: "project" | "issue" |
  "param" })` — every cross-tenant write/read is membership-checked.
- **Per-request `AsyncLocalStorage`** carrying `{ requestId, userId,
  workspaceId }` so services and ORM subscribers share a coherent view of
  the caller without prop drilling.
- **Global exception filter** mapping `OptimisticLockError` → 409,
  `EntityNotFoundError` → 404, FK / unique violations → 422, query
  timeouts → 504, into a stable `{ status, code, message, requestId }`
  envelope. No raw stacks on the wire.
- **Joi env validation** with secret hardening — production refuses to boot
  without `DB_PASSWORD` and a 32-char `JWT_SECRET`.
- **Helmet + CORS allow-list + `@nestjs/throttler`** with per-environment
  rate limits.
- **Structured `RequestId` propagation** (`X-Request-Id` echoed on every
  response, threaded into log lines and error envelopes).
- **JSON column transformers** centralising the MySQL-text vs PostgreSQL-
  jsonb asymmetry — service code passes plain objects, no manual
  `JSON.stringify` casts.
- **Crash-recoverable queue sentinel**: pending tags are reclaimable after
  30s instead of holding the row for the full 5-minute lease.
- **`@Transactional` on `softRemove` / `restore`** with `affected`-row 404
  signalling, closing the read-then-write TOCTOU window.
- **Optimistic lock simplified**: drop the redundant manual version pre-check
  that opened a TOCTOU between `findOne` and `save`; rely on the ORM's
  `UPDATE … WHERE version = ?` clause.
- **Missing FK indexes added**: `comments.author_id`,
  `activity_log.actor_user_id + created_at`, `memberships.user_id` single
  column for `byUser` lookups.
- **Health & readiness probes** (`/healthz`, `/readyz`) plus
  `propagateShutdown()` on `SIGTERM` to drain the connection pool cleanly.

## ORM bug surfaced + fixed

The previous version of `IssuesService.findOne` deliberately omitted
`assignee` / `reporter` / `sprint` / `parent` from the loaded relations and
left a comment explaining that joining the `user` table twice tripped
MariaDB's "Not unique table/alias" error. That was a real Stingerloom
RelationLoader defect: every eager `ManyToOne` JOIN used the *table name* as
the alias, so two relations to `User` produced two `LEFT JOIN user AS user`
clauses.

Fix shipped in this branch (`src/core/EntityManager.ts`): each eager
`ManyToOne` / `OneToOne` JOIN now uses the relation's *property name* as
the alias — `LEFT JOIN user AS assignee`, `LEFT JOIN user AS reporter`. The
SELECT side already aliased columns by `${rel.columnName}_${col.name}`, so
the change was only in the JOIN target alias and the matching ON clause.

The regression is locked in by `test/issues-relations.e2e-spec.ts`, which
loads `["labels","assignee","reporter","sprint","parent"]` from the same
`Issue` row.

## Why this isn't in `nestjs-blog`

`nestjs-blog` is the friendly starter — basic CRUD, soft-delete, simple
ManyToMany, GROUP BY/HAVING. It is intentionally easy to read on the first
day. This example is the next step: it assumes you already understand the
basics and shows how the ORM holds up when the SQL gets uncomfortable.
