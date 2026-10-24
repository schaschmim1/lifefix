-- Mein Plan: einmal im Supabase "SQL Editor" einfügen und auf "Run" tippen.
-- Legt die Tabelle für deine Daten und den privaten Speicher für deine Dateien an.
-- Jede Zeile gehört genau einem Konto; niemand sonst kann sie lesen.

create table if not exists public.docs (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  col text not null,
  id text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, col, id)
);
alter table public.docs enable row level security;
alter table public.docs replica identity full;

drop policy if exists "eigene Daten" on public.docs;
create policy "eigene Daten" on public.docs for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Felder zusammenführen statt das ganze Dokument zu überschreiben
create or replace function public.doc_merge(p_col text, p_id text, p_patch jsonb)
returns void language sql security invoker as $$
  insert into public.docs (user_id, col, id, data) values (auth.uid(), p_col, p_id, p_patch)
  on conflict (user_id, col, id) do update
    set data = public.docs.data || excluded.data, updated_at = now();
$$;

-- Live-Abgleich zwischen Handy, iPad und PC
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;

-- Privater Dateispeicher (PDFs usw.), jede Datei im Ordner deines Kontos
insert into storage.buckets (id, name, public) values ('files', 'files', false)
  on conflict (id) do nothing;
drop policy if exists "eigene Dateien" on storage.objects;
create policy "eigene Dateien" on storage.objects for all to authenticated
  using (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'files' and (storage.foldername(name))[1] = auth.uid()::text);
