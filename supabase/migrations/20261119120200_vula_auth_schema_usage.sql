-- The collector and verifier read auth.audit_log_entries (Supabase Auth audit trail).
-- On hosted Supabase the auth schema is owned by supabase_admin, so `grant usage on schema auth` from the
-- postgres role is silently ignored. Expose exactly the audit rows, read-only, via a SECURITY DEFINER function.
create or replace function vula.auth_audit_entries(
  after_ts timestamptz default '-infinity',
  after_id uuid default '00000000-0000-0000-0000-000000000000',
  max_rows int default 500
)
returns table (id text, payload json, created_at timestamptz, ip_address text)
language sql stable security definer set search_path = ''
as $$
  select e.id::text, e.payload, e.created_at, e.ip_address::text
  from auth.audit_log_entries e
  where (e.created_at, e.id) > (after_ts, after_id)
  order by e.created_at, e.id
  limit max_rows;
$$;

revoke all on function vula.auth_audit_entries(timestamptz, uuid, int) from public;
grant execute on function vula.auth_audit_entries(timestamptz, uuid, int) to vula_log, vula_auditor;
