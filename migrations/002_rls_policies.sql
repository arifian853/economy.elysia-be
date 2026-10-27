-- Module 4: RLS policies.
-- Jalankan di Supabase Dashboard -> SQL Editor setelah 001_initial.sql.
-- Aturan: user hanya boleh mengakses row miliknya (user_id = auth.uid()).

create policy "users can access own events"
on events
for all
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

-- participants & transactions: selain milik sendiri, event_id juga harus event milik user
-- (mencegah user menempelkan row ke event milik orang lain).
create policy "users can access own participants"
on participants
for all
to authenticated
using (user_id = auth.uid())
with check (
  user_id = auth.uid()
  and exists (
    select 1 from events e
    where e.id = participants.event_id and e.user_id = auth.uid()
  )
);

create policy "users can access own transactions"
on transactions
for all
to authenticated
using (user_id = auth.uid())
with check (
  user_id = auth.uid()
  and exists (
    select 1 from events e
    where e.id = transactions.event_id and e.user_id = auth.uid()
  )
);
