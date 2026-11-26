-- PUBLIC mirror of the TAR payloads that on-chain dataUri points to (task: public payload mirror).
-- The TAR contract's uriPrefix_ is a constructor argument, fixed forever when the TAR is created, so on testnet
-- DCAP_URI_PREFIX = https://<ref>.supabase.co/storage/v1/object/public/vula-tar/ and dataUri(v) = that + 0x{address}.
-- Contents: checkpoint payloads (hashes, sizes, timestamps, the public key) and the two TAR profile documents.
-- No event data: raw events and batches stay in the private vula-batches bucket.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('vula-tar', 'vula-tar', true, 10485760, array['application/json'])
on conflict (id) do update
  set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Anyone may READ through the public URL (public bucket). Only the log server's `service` Auth user may write;
-- upsert needs insert + update + select.
create policy vula_service_writes_tar_mirror on storage.objects
  for insert to authenticated
  with check (bucket_id = 'vula-tar' and vula.has_role(array['service']));
create policy vula_service_updates_tar_mirror on storage.objects
  for update to authenticated
  using (bucket_id = 'vula-tar' and vula.has_role(array['service']))
  with check (bucket_id = 'vula-tar' and vula.has_role(array['service']));
create policy vula_service_reads_tar_mirror on storage.objects
  for select to authenticated
  using (bucket_id = 'vula-tar' and vula.has_role(array['service']));
