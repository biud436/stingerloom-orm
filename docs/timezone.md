# Dates and Timezones

Every temporal value the ORM writes is bound to the statement as a JavaScript `Date`. The driver decides how that `Date` becomes bytes in the column, and the ORM decides how the column comes back as a `Date`. This page documents both halves so you can predict what lands in the database and what you read back.

## The rule

**The ORM never formats a date into a string before binding it.** `save`, `saveMany`, `insertMany`, `insertManyAndReturn`, `upsert`, `batchUpsert`, `update`, `updateMany`, `@CreateTimestamp`, `@UpdateTimestamp` and the query builder all bind the `Date` itself.

That matters because a hand-rolled format loses information. Before 2.0.0 the batch paths and the automatic timestamp columns formatted dates as `YYYY-MM-DD HH:MM:SS` in the process's local timezone: no offset, no milliseconds. The single-row paths bound the `Date`, so one column could hold two encodings, and a row written by `insertMany` came back with its milliseconds zeroed. Binding the `Date` everywhere removes that split.

## What each driver stores

| Driver | Bound `Date` becomes | Notes |
| --- | --- | --- |
| SQLite | ISO-8601 UTC text with milliseconds (`2026-03-01T12:34:56.789Z`) | better-sqlite3 accepts only numbers, strings, bigints, buffers and null, so the connector serializes with `toISOString()` |
| MySQL / MariaDB | `YYYY-MM-DD HH:MM:SS[.fff]` in the connection timezone | mysql2 converts using its `timezone` option, which defaults to the Node process timezone |
| PostgreSQL | An ISO-8601 string carrying the offset | `timestamptz` stores the instant; `timestamp` stores the wall time it resolves to |

## What you read back

Temporal columns (`datetime`, `timestamp`, `timestamptz`, `date`) hydrate to `Date`.

pg and mysql2 parse temporal columns at the driver. better-sqlite3 has no column type information and returns the stored text as-is, so the ORM converts it using the declared column type:

| Stored text | Decoded as |
| --- | --- |
| `2026-03-01T12:34:56.789Z` | UTC — the format the ORM writes |
| `2026-03-01 12:34:56` (no zone) | Local wall time — the format older versions wrote |
| `2026-03-01` | Local midnight, matching the pg/mysql2 `DATE` convention |
| Anything else | `new Date(value)`; unparseable text passes through unchanged rather than becoming an Invalid Date |

Epoch integers are passed through untouched: the ORM cannot tell seconds from milliseconds. Use a `@Column({ transformer })` if you store them.

## Column types

| Declared type | MySQL / MariaDB | PostgreSQL | SQLite |
| --- | --- | --- | --- |
| `datetime` | `DATETIME` | `TIMESTAMP` | `TEXT` |
| `timestamp` | `TIMESTAMP` | `TIMESTAMP` | `TEXT` |
| `timestamptz` | `DATETIME` (see below) | `TIMESTAMPTZ` | `TEXT` |
| `date` | `DATE` | `DATE` | `TEXT` |

MySQL and MariaDB have no zone-aware `DATETIME` type, so `timestamptz` is created as a plain `DATETIME` and the offset is not stored. The ORM logs one warning per process when it emits that mapping. Values still round-trip as the correct instant while the application timezone is stable; if you need the server to convert between session timezones, declare `timestamp` instead — MySQL's `TIMESTAMP` stores UTC internally, at the cost of a 2038 upper bound.

## Choosing a timezone for your application

The safest configuration is the boring one: **run every application process in UTC** (`TZ=UTC`) and let the presentation layer localize. Then the MySQL wall-clock encoding and the SQLite local-time fallback both coincide with UTC, and a value cannot shift when a process moves between machines.

If your processes do not run in UTC:

- Prefer `timestamptz` on PostgreSQL. It stores an instant, so no process-timezone assumption reaches the database.
- On MySQL, keep the `timezone` option of every connection consistent across all processes writing the same table. Two processes in different zones writing `DATETIME` values will disagree about what the stored wall time means.
- On SQLite, values written by 2.0.0 and later are UTC-marked, so they are unambiguous regardless of process timezone.

## Testing across timezones

A test suite that only ever runs in UTC cannot see a timezone defect: a zone-less local write and a correct UTC write produce identical text. The repository ships a matrix runner for its own temporal suites:

```bash
pnpm test:temporal-tz
```

It replays the temporal, soft-delete and cursor suites under `UTC`, `Asia/Seoul`, `America/New_York` and `Asia/Kolkata` (a half-hour offset). Setting `process.env.TZ` inside a test does not work — Jest hands the test a plain `process.env` copy without Node's timezone setter, so V8 keeps the zone it started with. The timezone has to be set per process, which is what the runner does.

The same applies to your own application tests: set `TZ` on the process, not in the test body.

## Soft deletes

`softDelete()` stamps the `@DeletedAt` column using the database clock — `NOW()` on MySQL and PostgreSQL, `strftime('%Y-%m-%dT%H:%M:%fZ','now')` on SQLite.

Before 2.0.0 the SQLite branch used `datetime('now')`, which renders UTC without a zone marker. The reader decodes zone-less text as local time, so `deletedAt` came back shifted by the process offset — nine hours early in `Asia/Seoul`. Stamps written by 2.0.0 and later carry the `Z` marker and decode correctly.

Rows soft-deleted by an earlier version keep the old, ambiguous encoding. If your `deletedAt` values matter beyond "is this row trashed", and you ran a non-UTC process, correct them once:

```sql
-- SQLite: re-stamp pre-2.0.0 rows as UTC-marked text.
-- Replace '+9 hours' with the negation of the offset the writing process ran in.
UPDATE my_table
SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at)
WHERE deleted_at IS NOT NULL
  AND deleted_at NOT LIKE '%Z';
```

Verify the result on a copy before running it against real data — the ORM cannot tell which process timezone wrote a zone-less value.

## Milliseconds

The ORM preserves the millisecond component of every `Date` it binds. Whether the database keeps it is a schema question:

- MySQL `DATETIME` and `TIMESTAMP` store whole seconds unless you declare fractional precision (`DATETIME(3)`).
- PostgreSQL `TIMESTAMP`/`TIMESTAMPTZ` keep microseconds by default.
- SQLite stores the text the connector produced, so milliseconds survive.

If you compare a saved entity against the `Date` you passed in and the millisecond fields differ, the column precision is the place to look.
