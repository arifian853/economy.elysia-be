-- Additive metadata only. Binary files stay in a private Cloudflare R2 bucket.
create table public.transaction_evidence (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.transactions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  evidence_type text not null check (evidence_type in ('link', 'file')),
  label text not null check (char_length(btrim(label)) between 1 and 200),
  link_url text,
  object_key text,
  file_name text,
  content_type text,
  byte_size bigint,
  created_at timestamptz not null default now(),
  constraint transaction_evidence_shape check (
    (evidence_type = 'link' and link_url is not null and object_key is null and file_name is null and content_type is null and byte_size is null)
    or
    (evidence_type = 'file' and link_url is null and object_key is not null and file_name is not null and content_type is not null and byte_size > 0)
  ),
  constraint transaction_evidence_link_length check (link_url is null or char_length(link_url) <= 2048),
  constraint transaction_evidence_file_size check (byte_size is null or byte_size <= 12582912)
);
create index transaction_evidence_transaction_idx on public.transaction_evidence(transaction_id, created_at);
alter table public.transaction_evidence enable row level security;
create policy transaction_evidence_select_owner on public.transaction_evidence
  for select to authenticated using (auth.uid() = user_id);
create policy transaction_evidence_insert_owner on public.transaction_evidence
  for insert to authenticated with check (auth.uid() = user_id);
create policy transaction_evidence_delete_owner on public.transaction_evidence
  for delete to authenticated using (auth.uid() = user_id);

create or replace function public.prevent_completed_evidence_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  target_transaction uuid;
  target_event uuid;
  transaction_owner uuid;
  target_status text;
begin
  if tg_op = 'DELETE' then target_transaction := old.transaction_id; else target_transaction := new.transaction_id; end if;
  if tg_op = 'UPDATE' and new.transaction_id is distinct from old.transaction_id then
    raise exception 'Evidence cannot be moved between transactions.' using errcode = '55000';
  end if;
  select event_id, user_id into target_event, transaction_owner from public.transactions where id = target_transaction;
  if target_event is null then
    if tg_op = 'DELETE' then return old; end if;
    raise exception 'Transaction not found.' using errcode = 'P0002';
  end if;
  if tg_op <> 'DELETE' and new.user_id is distinct from transaction_owner then
    raise exception 'Evidence owner must match transaction owner.' using errcode = '42501';
  end if;
  select status into target_status from public.events where id = target_event for update;
  if target_status = 'completed' then raise exception 'Completed events are archived and cannot be changed.' using errcode = '55000'; end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
create trigger transaction_evidence_archive_guard
before insert or update or delete on public.transaction_evidence
for each row execute function public.prevent_completed_evidence_mutation();
