-- UIBM Grades demo seed. ALL DATA IS SYNTHETIC.
-- Placeholders {{PROF_EMAIL}} {{PROF_PASSWORD}} {{AUDITOR_EMAIL}} {{AUDITOR_PASSWORD}} {{LOGSERVER_EMAIL}}
-- {{LOGSERVER_PASSWORD}} are substituted from .env at apply time (never commit real values).
-- Idempotent: safe to run twice.

create or replace function pg_temp.mk_user(p_email text, p_password text, p_name text) returns uuid
language plpgsql as $$
declare uid uuid;
begin
  select id into uid from auth.users where email = p_email;
  if uid is not null then return uid; end if;
  uid := gen_random_uuid();
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change,
    email_change_token_current, phone_change, phone_change_token, reauthentication_token)
  values (
    '00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', p_email,
    extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}'::jsonb, jsonb_build_object('full_name', p_name), now(), now(),
    '', '', '', '', '', '', '', '');
  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), uid, uid::text,
          jsonb_build_object('sub', uid::text, 'email', p_email, 'email_verified', true),
          'email', now(), now(), now());
  return uid;
end $$;

do $$
declare
  prof    uuid := pg_temp.mk_user('{{PROF_EMAIL}}', '{{PROF_PASSWORD}}', 'Prof. Arben Krasniqi');
  prof2   uuid := pg_temp.mk_user('prof.gashi@uibm.test', encode(extensions.gen_random_bytes(18), 'base64'), 'Prof. Vjosa Gashi');
  auditor uuid := pg_temp.mk_user('{{AUDITOR_EMAIL}}', '{{AUDITOR_PASSWORD}}', 'External Auditor');
  svc     uuid := pg_temp.mk_user('{{LOGSERVER_EMAIL}}', '{{LOGSERVER_PASSWORD}}', 'Vula log server');
  c101 uuid; c205 uuid; c310 uuid;
begin
  insert into app.roles (user_id, role) values
    (prof, 'professor'), (prof2, 'professor'), (auditor, 'auditor'), (svc, 'service')
  on conflict (user_id) do nothing;

  insert into app.courses (code, title, professor_id) values
    ('CS101', 'Programming I', prof),
    ('CS205', 'Databases', prof),
    ('CS310', 'Computer Networks', prof2)
  on conflict (code) do nothing;
  select id into c101 from app.courses where code = 'CS101';
  select id into c205 from app.courses where code = 'CS205';
  select id into c310 from app.courses where code = 'CS310';

  insert into app.students (student_no, full_name) values
    ('UIBM-2026-001', 'Arta Hoxha'),       ('UIBM-2026-002', 'Blerim Morina'),
    ('UIBM-2026-003', 'Dafina Berisha'),   ('UIBM-2026-004', 'Driton Shala'),
    ('UIBM-2026-005', 'Elira Kelmendi'),   ('UIBM-2026-006', 'Fatlind Rexhepi'),
    ('UIBM-2026-007', 'Gentiana Bytyqi'),  ('UIBM-2026-008', 'Ilir Mustafa'),
    ('UIBM-2026-009', 'Jeta Rama'),        ('UIBM-2026-010', 'Kushtrim Hajdari'),
    ('UIBM-2026-011', 'Lirie Zeka'),       ('UIBM-2026-012', 'Mentor Ahmeti')
  on conflict (student_no) do nothing;

  -- Last term's CS101 and CS310 grades (already final). CS205 grades are entered live in the demo.
  insert into app.grades (student_id, course_id, grade, updated_by)
  select s.id, c101, g.grade, prof
  from app.students s
  join (values ('UIBM-2026-001', 9), ('UIBM-2026-002', 7), ('UIBM-2026-003', 10), ('UIBM-2026-004', 6),
               ('UIBM-2026-005', 8), ('UIBM-2026-006', 5), ('UIBM-2026-007', 9), ('UIBM-2026-008', 7))
       as g(no, grade) on g.no = s.student_no
  on conflict (student_id, course_id) do nothing;

  insert into app.grades (student_id, course_id, grade, updated_by)
  select s.id, c310, g.grade, prof2
  from app.students s
  join (values ('UIBM-2026-009', 8), ('UIBM-2026-010', 6), ('UIBM-2026-011', 9), ('UIBM-2026-012', 7))
       as g(no, grade) on g.no = s.student_no
  on conflict (student_id, course_id) do nothing;
end $$;
