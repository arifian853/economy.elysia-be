-- Sharing is opt-in: NULL means the event remains private.
alter table public.events
  add column if not exists public_share_token text;

create unique index if not exists events_public_share_token_uidx
  on public.events (public_share_token)
  where public_share_token is not null;

comment on column public.events.public_share_token is
  'Random bearer token for an explicitly enabled, read-only public event view.';

-- Anonymous readers can call this projection only; RLS on the base tables is unchanged.
create or replace function public.get_public_event(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'event', pg_catalog.jsonb_build_object(
      'name', e.name,
      'eventDate', e.event_date::text
    ),
    'entries', coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'type', 'expense',
          'name', t.name,
          'amount', t.quantity::bigint * t.unit_price,
          'transactionAt', pg_catalog.to_char(
            t.transaction_at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS"Z"'
          )
        ) order by t.transaction_at desc
      ) filter (where t.id is not null),
      '[]'::pg_catalog.jsonb
    )
  )
  from public.events as e
  left join public.transactions as t on t.event_id = e.id
  where e.public_share_token = p_token
    and p_token is not null
  group by e.id;
$function$;

revoke all on function public.get_public_event(text) from public;
grant execute on function public.get_public_event(text) to anon, authenticated;
