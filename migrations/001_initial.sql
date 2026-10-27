-- Module 1: initial schema.
-- Jalankan di Supabase Dashboard -> SQL Editor (atau via Supabase CLI).
-- RLS diaktifkan di sini; policy dibuat di Module 4 (002_rls_policies.sql).
-- Sebelum policy ada, anon/authenticated tidak bisa mengakses row apa pun (default deny).

create table events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  event_date date not null,
  budget bigint not null check (budget > 0),
  status text not null check (
    status in ('upcoming', 'active', 'completed')
  ),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table participants (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create table transactions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  quantity integer not null check (quantity > 0),
  unit_price bigint not null check (unit_price >= 0),
  payment_method text not null check (
    payment_method in ('cash', 'transfer', 'qris', 'ewallet', 'other')
  ),
  note text,
  transaction_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Index foreign key yang dipakai untuk query per user / per event.
create index events_user_id_idx on events (user_id);
create index participants_event_id_idx on participants (event_id);
create index transactions_event_id_idx on transactions (event_id);

alter table events enable row level security;
alter table participants enable row level security;
alter table transactions enable row level security;
