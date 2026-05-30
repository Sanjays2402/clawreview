# Database backup and restore

Logical backups of the clawreview Postgres database are produced by the
`{{ .Release.Name }}-pg-backup` Kubernetes CronJob shipped in the Helm
chart (`infra/helm/clawreview/templates/cronjob-backup.yaml`). This page
covers the operational contract: schedule, retention, verification, and
the exact restore procedure.

## What gets backed up

A single `pg_dump --format=plain --no-owner --no-privileges
--serializable-deferrable` of the whole database referenced by
`secrets.databaseUrl`, gzipped and uploaded to
`s3://${bucket}/${prefix}/clawreview-<UTC timestamp>.sql.gz`.

Tables covered include every model in `packages/db` (reviews, findings,
audit log, installations, budgets, rerun queue, SLA buckets, GDPR
requests). Redis is intentionally excluded because it only holds queue
state and rate-limit counters that are safe to rebuild on cold start.

## Configuring

Set the following in the environment's Helm values, then `helm upgrade`:

```yaml
backup:
  enabled: true
  schedule: "15 3 * * *"
  s3:
    bucket: "clawreview-backups-prod"
    prefix: "clawreview/postgres"
    region: "us-east-1"
    accessKeyId: "<rotated IAM key>"
    secretAccessKey: "<rotated IAM secret>"
```

For non-AWS object stores (MinIO, Cloudflare R2, Backblaze B2, Wasabi)
also set `backup.s3.endpoint` to the provider endpoint URL. The bucket
should have lifecycle rules that transition objects to cold storage and
expire them past your retention window; the CronJob itself does not
delete anything.

## Verification

After enabling, confirm the first run:

```sh
kubectl get cronjob -l app.kubernetes.io/component=backup
kubectl get jobs -l app.kubernetes.io/component=backup --sort-by=.metadata.creationTimestamp | tail
kubectl logs job/<release>-pg-backup-<suffix>
aws s3 ls s3://<bucket>/<prefix>/ --human-readable | tail
```

The container refuses to upload dumps smaller than
`backup.minDumpBytes` (4 KiB by default) to catch the silent
pg_dump-failure case where only headers are written.

Run a monthly fire drill that restores the latest dump into a scratch
database and counts a handful of tables; an automated restore is the
only backup that counts.

## Restore

The restore procedure is intentionally manual so an operator has to make
the destructive `DROP DATABASE` decision explicitly.

1. Pick the dump to restore from and download it:

   ```sh
   aws s3 ls s3://<bucket>/<prefix>/ | tail
   aws s3 cp s3://<bucket>/<prefix>/clawreview-<ts>.sql.gz /tmp/restore.sql.gz
   gunzip -t /tmp/restore.sql.gz   # integrity check
   ```

2. Quiesce writes. Scale the server and any workers to zero so no new
   rows land mid-restore:

   ```sh
   kubectl scale deploy <release>-server --replicas=0
   kubectl scale deploy <release>-worker --replicas=0   # if separate
   ```

3. Create the target database. Restoring into the live database
   risks partial state on failure. Restore into a fresh name, then
   rename:

   ```sh
   psql "$ADMIN_URL" -c "CREATE DATABASE clawreview_restore;"
   gunzip -c /tmp/restore.sql.gz | \
     psql "$ADMIN_URL/clawreview_restore" --single-transaction --set ON_ERROR_STOP=on
   ```

4. Smoke check the restored database:

   ```sh
   psql "$ADMIN_URL/clawreview_restore" -c 'SELECT count(*) FROM "Review";'
   psql "$ADMIN_URL/clawreview_restore" -c 'SELECT count(*) FROM "AuditLog";'
   psql "$ADMIN_URL/clawreview_restore" -c 'SELECT max("createdAt") FROM "Review";'
   ```

5. Cut over by renaming. The old database is kept as
   `clawreview_corrupt_<ts>` for forensics until storage pressure forces
   cleanup:

   ```sh
   psql "$ADMIN_URL" <<SQL
   ALTER DATABASE clawreview RENAME TO clawreview_corrupt_$(date -u +%Y%m%dT%H%M%SZ);
   ALTER DATABASE clawreview_restore RENAME TO clawreview;
   SQL
   ```

6. Scale the server and workers back up. Watch `/readyz`, the
   `clawreview_queue_depth` metric, and `ClawreviewReviewFailureRate`
   for one full SLA window before declaring the incident closed.

   ```sh
   kubectl scale deploy <release>-server --replicas=2
   kubectl rollout status deploy/<release>-server
   ```

## Recovery point and recovery time

- RPO: up to 24 hours with the default daily schedule. Run more often
  (every 6h is cheap on a small dataset) when the business needs a
  tighter window.
- RTO: dominated by the `psql` reload time, which scales with database
  size. Budget 5 minutes per 100 MB of compressed dump for planning.

## Failure modes

- `dump too small` exit: pg_dump produced fewer than `minDumpBytes`.
  Treat as a hard failure; investigate connectivity to Postgres before
  re-running.
- S3 4xx: rotate the IAM credentials in
  `secrets.backup.s3.accessKeyId/secretAccessKey`, `helm upgrade`, then
  trigger a manual run with `kubectl create job --from=cronjob/...`.
- CronJob `MissedSchedule` event: the cluster was unreachable longer
  than `startingDeadlineSeconds` (default 10 minutes). Run an out-of-band
  backup immediately; the next scheduled run will resume normal cadence.
