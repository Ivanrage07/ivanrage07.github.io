create extension if not exists pgcrypto;

create table if not exists public.wordle_puzzles (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'custom' check (kind in ('custom')),
  answer text not null check (answer ~ '^[a-z]{5}$'),
  answer_code text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.wordle_attempts (
  id uuid primary key default gen_random_uuid(),
  puzzle_key text not null,
  puzzle_kind text not null check (puzzle_kind in ('daily', 'casual', 'custom')),
  puzzle_label text not null,
  answer text not null check (answer ~ '^[a-z]{5}$'),
  won boolean not null,
  guesses_used integer not null check (guesses_used between 1 and 6),
  max_guesses integer not null default 6,
  guesses jsonb not null default '[]'::jsonb,
  player_id text,
  user_id uuid references auth.users(id) on delete set null,
  player_email text,
  player_name text,
  created_at timestamptz not null default now()
);

create table if not exists public.wordle_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  avatar_url text,
  last_seen timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.wordle_admins (
  email text primary key,
  created_at timestamptz not null default now()
);

-- Add your admin email in the SQL editor after running the schema:
-- insert into public.wordle_admins (email) values ('you@example.com') on conflict do nothing;

alter table public.wordle_puzzles enable row level security;
alter table public.wordle_attempts enable row level security;
alter table public.wordle_profiles enable row level security;
alter table public.wordle_admins enable row level security;

alter table public.wordle_attempts
add column if not exists user_id uuid references auth.users(id) on delete set null;

alter table public.wordle_attempts
add column if not exists player_email text;

alter table public.wordle_attempts
add column if not exists player_name text;

alter table public.wordle_attempts
drop constraint if exists wordle_attempts_puzzle_kind_check;

alter table public.wordle_attempts
add constraint wordle_attempts_puzzle_kind_check
check (puzzle_kind in ('daily', 'casual', 'custom'));

drop policy if exists "Anyone can create custom puzzles" on public.wordle_puzzles;
create policy "Anyone can create custom puzzles"
on public.wordle_puzzles
for insert
to anon
with check (true);

drop policy if exists "Anyone can load custom puzzles" on public.wordle_puzzles;
create policy "Anyone can load custom puzzles"
on public.wordle_puzzles
for select
to anon
using (true);

drop policy if exists "Anyone can log attempts" on public.wordle_attempts;
drop policy if exists "Guests can log attempts" on public.wordle_attempts;
drop policy if exists "Signed in players can log attempts" on public.wordle_attempts;
create policy "Guests can log attempts"
on public.wordle_attempts
for insert
to anon
with check (user_id is null);

create policy "Signed in players can log attempts"
on public.wordle_attempts
for insert
to authenticated
with check (user_id = auth.uid());

drop policy if exists "Anyone can read attempts" on public.wordle_attempts;
drop policy if exists "Only admins can read attempts" on public.wordle_attempts;
create policy "Only admins can read attempts"
on public.wordle_attempts
for select
to authenticated
using (
  exists (
    select 1
    from public.wordle_admins admins
    where lower(admins.email) = lower(auth.jwt() ->> 'email')
  )
);

drop policy if exists "Admins can read their allowlist row" on public.wordle_admins;
create policy "Admins can read their allowlist row"
on public.wordle_admins
for select
to authenticated
using (lower(email) = lower(auth.jwt() ->> 'email'));

drop policy if exists "Players can create their profile" on public.wordle_profiles;
create policy "Players can create their profile"
on public.wordle_profiles
for insert
to authenticated
with check (user_id = auth.uid());

drop policy if exists "Players can update their profile" on public.wordle_profiles;
create policy "Players can update their profile"
on public.wordle_profiles
for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "Players can read their profile" on public.wordle_profiles;
create policy "Players can read their profile"
on public.wordle_profiles
for select
to authenticated
using (user_id = auth.uid());

create index if not exists wordle_attempts_created_at_idx
on public.wordle_attempts (created_at desc);

create index if not exists wordle_attempts_puzzle_key_idx
on public.wordle_attempts (puzzle_key);

grant usage on schema public to anon;
grant usage on schema public to authenticated;
grant select, insert on public.wordle_puzzles to anon;
grant select on public.wordle_puzzles to authenticated;
revoke select on public.wordle_attempts from anon;
grant insert on public.wordle_attempts to anon;
grant insert, select on public.wordle_attempts to authenticated;
grant insert, update, select on public.wordle_profiles to authenticated;
grant select on public.wordle_admins to authenticated;
