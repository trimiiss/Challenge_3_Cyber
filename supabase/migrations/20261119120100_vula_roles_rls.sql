-- Vula roles, grants, RLS and storage (CLAUDE.md §7.4)
-- Passwords are NOT set here (never in migration history). Set them once with:
--   alter role <name> password '<secret>';    (values live only in the local .env)
--
--   vula_log      log server + collector: reads the source audit tables, writes vula.*
--   vula_auditor  verifier: read-only on everything it checks, may append alerts
--   uibm_app      UIBM Grades app backend: app.* only
--   uibm_admin    the INSIDER of the demo story: a DBA with full rights on app, app_audit and vula
--                 (same power over these tables as the postgres role). Used only by /attacks.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'vula_log') then
    create role vula_log login bypassrls noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'vula_auditor') then
    create role vula_auditor login bypassrls noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'uibm_app') then
    create role uibm_app login bypassrls noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'uibm_admin') then
    create role uibm_admin login bypassrls noinherit;
  end if;
end
$$;

-- ---------------------------------------------------------------- vula_log
grant usage on schema vula, app_audit to vula_log;
grant select, insert, update on all tables in schema vula to vula_log;
grant select on app_audit.events to vula_log;
grant select on auth.audit_log_entries to vula_log;

-- ------------------------------------------------------------ vula_auditor
grant usage on schema vula, app_audit, app to vula_auditor;
grant select on all tables in schema vula, app_audit, app to vula_auditor;
grant select on auth.audit_log_entries to vula_auditor;
grant insert on vula.alerts to vula_auditor;

-- ---------------------------------------------------------------- uibm_app
grant usage on schema app to uibm_app;
grant select, insert, update, delete on all tables in schema app to uibm_app;
grant select on auth.users to uibm_app;   -- display names / emails of professors

-- -------------------------------------------------------------- uibm_admin
grant usage on schema app, app_audit, vula to uibm_admin;
grant all on all tables in schema app, app_audit, vula to uibm_admin;
grant all on all sequences in schema app, app_audit, vula to uibm_admin;

-- ================================================================== RLS
-- Enabled on every table. The service roles above bypass it; the dashboard (Supabase Auth user) gets
-- read access only through these policies.
alter table app.students        enable row level security;
alter table app.courses         enable row level security;
alter table app.grades          enable row level security;
alter table app.roles           enable row level security;
alter table app.logins          enable row level security;
alter table app_audit.events    enable row level security;
alter table vula.config         enable row level security;
alter table vula.leaves         enable row level security;
alter table vula.checkpoints    enable row level security;
alter table vula.collector_state enable row level security;
alter table vula.alerts         enable row level security;

create or replace function vula.has_role(roles text[]) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from app.roles r where r.user_id = auth.uid() and r.role = any (roles));
$$;
revoke all on function vula.has_role(text[]) from public;
grant execute on function vula.has_role(text[]) to authenticated;

grant usage on schema vula, app to authenticated;
grant select on vula.alerts, vula.checkpoints, vula.config to authenticated;
grant select on app.roles to authenticated;

create policy auditors_read_alerts on vula.alerts
  for select to authenticated using (vula.has_role(array['auditor', 'admin']));
create policy auditors_read_checkpoints on vula.checkpoints
  for select to authenticated using (vula.has_role(array['auditor', 'admin']));
create policy auditors_read_config on vula.config
  for select to authenticated using (vula.has_role(array['auditor', 'admin']));
create policy read_own_role on app.roles
  for select to authenticated using (user_id = auth.uid());

-- ============================================================== Storage
-- Private bucket for the raw event batch of each checkpoint (its SHA-256 is inside the anchored payload).
insert into storage.buckets (id, name, public)
values ('vula-batches', 'vula-batches', false)
on conflict (id) do nothing;

create policy vula_service_writes_batches on storage.objects
  for insert to authenticated
  with check (bucket_id = 'vula-batches' and vula.has_role(array['service']));
create policy vula_reads_batches on storage.objects
  for select to authenticated
  using (bucket_id = 'vula-batches' and vula.has_role(array['service', 'auditor', 'admin']));
