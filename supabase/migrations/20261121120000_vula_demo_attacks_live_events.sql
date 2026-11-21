-- Stretch items of CLAUDE.md §7 (2026-11-21)
--  1. Attack 3: the insider deletes rows of auth.audit_log_entries.
--  2. Live events page: auditors may read vula.leaves; leaves are published to Realtime.

-- ============================================================== 1. attack 3 (DEMO ONLY)
-- auth.audit_log_entries belongs to supabase_auth_admin; on hosted Supabase only the postgres superuser can
-- delete there. The insider of the demo story holds the postgres password. Rather than putting that password in
-- the repo, this one SECURITY DEFINER function (owned by postgres) gives the demo insider role exactly that power:
-- delete the given auth audit entries. Never deploy this outside the demo project.
create schema if not exists vula_demo;
revoke all on schema vula_demo from public;
grant usage on schema vula_demo to uibm_admin;

create or replace function vula_demo.insider_delete_auth_entries(p_ids uuid[])
returns setof uuid
language sql
volatile
security definer
set search_path = ''
as $$
  delete from auth.audit_log_entries where id = any(p_ids) returning id;
$$;
revoke all on function vula_demo.insider_delete_auth_entries(uuid[]) from public, anon, authenticated, service_role;
grant execute on function vula_demo.insider_delete_auth_entries(uuid[]) to uibm_admin;

comment on function vula_demo.insider_delete_auth_entries(uuid[]) is
  'DEMO ONLY (attack 3): lets the insider role delete Supabase Auth audit entries, as the postgres superuser can.';

-- ============================================================== 2. live events page
grant select on vula.leaves to authenticated;
create policy auditors_read_leaves on vula.leaves
  for select to authenticated using (vula.has_role(array['auditor', 'admin']));
alter publication supabase_realtime add table vula.leaves;
