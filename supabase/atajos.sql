-- PETACA · Atajos del iPhone: cargar gastos, ingresos y notas, y preguntar cuánto te queda, sin abrir la app.
-- Pegar en Supabase → SQL Editor → Run. Se puede correr más de una vez sin problema.

-- 1) La clave de cada cuenta para el Atajo. Se guarda solo su huella (SHA-256): la clave entera se ve una sola vez, al crearla.
--    Sin políticas: solo la Edge Function "atajo" (con la service role) la crea, la busca y la borra.
create table if not exists public.atajo_claves (
  user_id uuid primary key references auth.users on delete cascade,
  hash text not null unique check (char_length(hash) = 64),
  creado timestamptz not null default now(),
  usado timestamptz
);
alter table public.atajo_claves enable row level security;
revoke all on public.atajo_claves from anon, authenticated;

-- 2) La bandeja: lo que mandó el Atajo y todavía no entró al panel. La función agrega; la página, al abrirse, lo lee y lo
--    borra (lo que borra es lo que suma, así si dos dispositivos se abren a la vez, cada cosa entra una sola vez).
create table if not exists public.atajo_bandeja (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  tipo text not null check (tipo in ('gasto', 'ingreso', 'nota')),
  datos jsonb not null check (pg_column_size(datos) <= 2000),
  creado timestamptz not null default now()
);
create index if not exists atajo_bandeja_user on public.atajo_bandeja (user_id, id);
alter table public.atajo_bandeja enable row level security;
drop policy if exists "atajo_bandeja: solo el dueño" on public.atajo_bandeja;
create policy "atajo_bandeja: solo el dueño" on public.atajo_bandeja
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
revoke all on public.atajo_bandeja from anon, authenticated;
grant select, delete on public.atajo_bandeja to authenticated;

-- Para ver qué hay en las bandejas:
-- select user_id, tipo, datos, creado from public.atajo_bandeja order by id desc limit 50;
