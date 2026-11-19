-- Vula schema (CLAUDE.md §7.4)
--   app        UIBM Grades demo app data
--   app_audit  audit trail written by AFTER INSERT/UPDATE/DELETE triggers on app.*
--   vula       the tamper-evident log: leaves, checkpoints, collector cursors, alerts

create schema if not exists app;
create schema if not exists app_audit;
create schema if not exists vula;

-- ============================================================================
-- Demo app: UIBM Grades (all data synthetic)
-- ============================================================================
create table app.students (
  id          uuid primary key default gen_random_uuid(),
  student_no  text not null unique,
  full_name   text not null,
  created_at  timestamptz not null default now()
);

create table app.courses (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,
  title         text not null,
  professor_id  uuid references auth.users (id),
  created_at    timestamptz not null default now()
);

-- Kosovo scale: 5 = fail, 6..10 = pass
create table app.grades (
  id          uuid primary key default gen_random_uuid(),
  student_id  uuid not null references app.students (id),
  course_id   uuid not null references app.courses (id),
  grade       smallint not null check (grade between 5 and 10),
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  unique (student_id, course_id)
);

create table app.roles (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  role        text not null check (role in ('admin', 'professor', 'student', 'auditor', 'service')),
  granted_by  uuid,
  granted_at  timestamptz not null default now()
);

-- App-level login record (complements auth.audit_log_entries)
create table app.logins (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  at          timestamptz not null default now(),
  user_agent  text
);

-- ============================================================================
-- Audit trail (the "source system" evidence Vula captures)
-- ============================================================================
create table app_audit.events (
  id           bigint generated always as identity primary key,
  occurred_at  timestamptz not null default clock_timestamp(),
  table_name   text not null,
  op           text not null check (op in ('INSERT', 'UPDATE', 'DELETE')),
  row_pk       text,
  old_row      jsonb,
  new_row      jsonb,
  actor        uuid,                                  -- auth.uid() of the app user, if any
  db_user      text not null default session_user,    -- the database login that ran the statement
  txid         bigint not null default txid_current()
);

create or replace function app_audit.capture() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old   jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new   jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_actor uuid;
begin
  begin
    v_actor := auth.uid();
  exception when others then
    v_actor := null;
  end;
  insert into app_audit.events (table_name, op, row_pk, old_row, new_row, actor)
  values (
    tg_table_schema || '.' || tg_table_name,
    tg_op,
    coalesce(v_new ->> 'id', v_old ->> 'id', v_new ->> 'user_id', v_old ->> 'user_id'),
    v_old,
    v_new,
    v_actor
  );
  return null;
end;
$$;

create trigger audit_students after insert or update or delete on app.students
  for each row execute function app_audit.capture();
create trigger audit_courses after insert or update or delete on app.courses
  for each row execute function app_audit.capture();
create trigger audit_grades after insert or update or delete on app.grades
  for each row execute function app_audit.capture();
create trigger audit_roles after insert or update or delete on app.roles
  for each row execute function app_audit.capture();
create trigger audit_logins after insert or update or delete on app.logins
  for each row execute function app_audit.capture();

-- ============================================================================
-- Vula log
-- ============================================================================
create table vula.config (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

-- leaf bytes = JCS(event); leaf_hash = SHA-256(0x00 || leaf bytes)  (RFC 9162 §2.1.1)
create table vula.leaves (
  index        bigint primary key check (index >= 0),
  leaf_hash    bytea not null check (length(leaf_hash) = 32),
  event        jsonb not null,
  captured_at  timestamptz not null default now()
);

-- One row per checkpoint = one TAR version (seq == on-chain version index)
create table vula.checkpoints (
  seq          bigint primary key check (seq >= 0),
  tree_size    bigint not null,
  root_hash    bytea not null check (length(root_hash) = 32),
  payload      jsonb not null,
  checksum     bytea not null check (length(checksum) = 32),   -- SHA-256(JCS(payload)) = on-chain bytes32
  status       text not null check (status in ('pending', 'anchored', 'failed')),
  tar_version  bigint,
  tx_hash      text,
  anchored_at  timestamptz,
  attempts     int not null default 0,
  last_error   text,
  created_at   timestamptz not null default now()
);

create table vula.collector_state (
  source      text primary key,
  cursor      jsonb not null,
  updated_at  timestamptz not null default now()
);

create table vula.alerts (
  id          bigint generated always as identity primary key,
  kind        text not null,
  severity    text not null check (severity in ('info', 'warning', 'critical')),
  title       text not null,
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index alerts_created_at on vula.alerts (created_at desc);

-- Realtime for the dashboard (alerts + new checkpoints)
alter publication supabase_realtime add table vula.alerts;
alter publication supabase_realtime add table vula.checkpoints;
