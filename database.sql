create extension if not exists pgcrypto;

create table if not exists public.support_references (
  id uuid primary key default gen_random_uuid(),
  url text not null,
  normalized_url text not null unique,
  title text,
  content text,
  status text not null default 'pending',
  error text,
  tags text,
  source_type text default 'article',
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists support_references_updated_at_idx
  on public.support_references (updated_at desc);

create index if not exists support_references_status_idx
  on public.support_references (status);

create or replace function public.set_support_references_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists support_references_set_updated_at on public.support_references;

create trigger support_references_set_updated_at
before update on public.support_references
for each row
execute function public.set_support_references_updated_at();
