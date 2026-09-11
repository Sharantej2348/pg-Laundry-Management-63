-- PG Laundry Status — Supabase schema
-- Run this once in your project's SQL Editor (Supabase Dashboard → SQL Editor → New query → Run).

-- 1. Table -------------------------------------------------------------
create table if not exists machines (
  id          text primary key,             -- 'left' | 'middle' | 'right'
  label       text not null,
  status      text not null default 'available'
                check (status in ('available', 'washing', 'finished', 'outOfOrder')),
  user_name   text,
  user_room   text,
  start_time  timestamptz,
  end_time    timestamptz,
  note        text,
  reported_at timestamptz,
  updated_at  timestamptz not null default now()
);

-- Keep updated_at current on every change (handy for debugging/staleness checks).
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_machines_updated_at on machines;
create trigger trg_machines_updated_at
  before update on machines
  for each row execute function set_updated_at();

-- 2. Seed the three machines (safe to re-run) --------------------------
insert into machines (id, label, status)
values
  ('left', 'Left Machine', 'available'),
  ('middle', 'Middle Machine', 'available'),
  ('right', 'Right Machine', 'available')
on conflict (id) do nothing;

-- 3. Turn on Realtime for this table ------------------------------------
-- This is what lets every connected phone get pushed the new row the
-- instant it changes, instead of polling.
alter publication supabase_realtime add table machines;

-- 4. Row Level Security ---------------------------------------------------
-- This app has no accounts (matches the current MVP's trust model — any
-- resident can act on any machine). Public read/update, no delete, no
-- direct insert (the three rows are seeded once, above).
alter table machines enable row level security;

drop policy if exists "Public can read machines" on machines;
create policy "Public can read machines"
  on machines for select
  using (true);

drop policy if exists "Public can update machines" on machines;
create policy "Public can update machines"
  on machines for update
  using (true)
  with check (true);

-- 5. Atomic claim function -------------------------------------------------
-- This is the piece that actually fixes the "two people tap Use Machine
-- at the same time" race condition. The UPDATE's WHERE clause and the
-- row match happen as one atomic operation in Postgres — if two requests
-- arrive together, only one can match status = 'available' and win.
-- The loser gets zero rows back and the frontend shows "already claimed."
create or replace function claim_machine(
  p_id text,
  p_name text,
  p_room text,
  p_minutes int
)
returns setof machines
language plpgsql
security definer
as $$
begin
  if p_minutes is null or p_minutes <= 0 or p_minutes > 240 then
    raise exception 'Invalid duration';
  end if;

  return query
    update machines
    set status = 'washing',
        user_name = nullif(p_name, ''),
        user_room = nullif(p_room, ''),
        start_time = now(),
        end_time = now() + (p_minutes || ' minutes')::interval,
        note = null,
        reported_at = null
    where id = p_id and status = 'available'
    returning *;
end;
$$;

grant execute on function claim_machine(text, text, text, int) to anon, authenticated;
