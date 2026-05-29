# Backups

- Postgres: managed snapshot every six hours, retained for seven days. Restore
  rehearsal once per quarter on a scratch environment.
- Redis: not backed up. Queue depth is ephemeral and recovers on next webhook.
- Secrets: rotate quarterly, document rotation date in the audit log.
