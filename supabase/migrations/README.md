# Migrations

Applied in filename order by `pnpm db:push` (see `scripts/migrate.ts`).

| File | What |
|---|---|
| `0001_schema.sql` | Tables, indexes, constraints, `jobs_public` view, RLS lockdown |
| `0002_claim_job.sql` | `claim_job()` global rate gate, `used_quota()`, `queue_position()`, `reap_expired_leases()` |
| `0003_cron.sql` | pg_cron heartbeat that pokes the Vercel worker over pg_net |

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
