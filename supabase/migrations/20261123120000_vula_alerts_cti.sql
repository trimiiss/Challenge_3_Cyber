-- BCBCTI hand-off (CLAUDE.md §0 stretch #1): the log server shares every warning/critical alert as a STIX 2.1
-- incident through Compellio's BCBCTI and records the resulting TAR here. vula_log already has
-- select/insert/update on vula.*; the dashboard reads it through vula_auditor (select on vula.*).
alter table vula.alerts add column if not exists cti jsonb;

comment on column vula.alerts.cti is
  'BCBCTI hand-off state: {state: submitted|registered|failed, objectId, statusId, tarId, registryVersion, receiptId, error}';
