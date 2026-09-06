# Migrations

Applied in filename order by `pnpm db:push` (see `scripts/migrate.ts`).

| File | What |
|---|---|
| `0001_schema.sql` | Tables, indexes, constraints, `jobs_public` view, RLS lockdown |
| `0002_claim_job.sql` | `claim_job()` global rate gate, `used_quota()`, `queue_position()`, `ms_until_slot()`, `reap_expired_leases()` |
| `0003_cron.sql` | `pump_worker()` + the pg_cron heartbeat that pokes the Vercel worker over pg_net |
| `0004_reserve_attempt.sql` | `reserve_attempt()` — the cap check and the job insert in ONE transaction |
| `0005_cron_health.sql` | `cron_health()`, so the teacher console can tell a scheduled cron from a *working* one |
| `0006_style_samples.sql` | `style_samples` — the pinned thumbnails on the student's style cards (PRD §F4) |
| `0007_expire_queued.sql` | Extends `reap_expired_leases()` and `pump_worker()` so a `queued` job cannot sit past its deadline forever |

Later files redefine functions from earlier ones (`0007` rewrites two of `0003`'s
and `0002`'s). Everything is `create or replace` / `if not exists`, so the whole
directory is safe to re-run, but only **in order** — applying `0007` to a
database that never got `0002` fails.

## Where the pieces live

Three invariants are enforced in SQL and nowhere else, because on Vercel many
lambdas run at once and anything in-process would silently permit *limit ×
instances*:

- **the rate gate** — `claim_job()` (`0002`), which advances a single pacer row
- **the quota and the cap** — `reserve_attempt()` (`0004`), lock order
  `sessions -> devices`, fixed there and taken nowhere else
- **nothing gets stranded** — `reap_expired_leases()` (`0002`, extended by
  `0007`), run at the top of every worker tick

## Before running 0003

`0003` needs two Vault secrets. Create them once in the Supabase SQL editor:

```sql
select vault.create_secret('https://your-app.vercel.app', 'app_url');
select vault.create_secret('<the value of WORKER_SECRET>', 'worker_secret');
```

Then verify the schedule took:

```sql
select jobname, schedule, active from cron.job;
select * from cron.job_run_details order by start_time desc limit 5;
-- pg_net is fire-and-forget: a green cron run does NOT prove the worker ran.
select * from net._http_response order by created desc limit 5;   -- kept 6h only
```

## Prerequisites to check on day one (30 seconds)

- Postgres >= 15.1.1.61 (required for the `'10 seconds'` schedule string)
- `pg_cron` and `pg_net` enabled under Database > Extensions
