# apps/collector

Polls Supabase every 10 s: `app_audit.events` (trigger table), `auth.audit_log_entries`, and emits a heartbeat leaf every
minute so silence is detectable. Cursor per source in `vula.collector_state`. **Milestone M2.**
