// Monta um Postgres em memória (PGlite) com o mínimo do Supabase que as
// migrações usam: papéis anon/authenticated, auth.uid(), storage, pg_cron,
// publicação do realtime. Depois aplica as migrações + o seed do projeto.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const STUBS = `
  create role anon nologin; create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable as $$ select jsonb_build_object('email', 'shirley@teste.com') $$;
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid default gen_random_uuid(), bucket_id text, name text);
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql as $$ select string_to_array(name, '/') $$;
  create schema cron;
  create table cron.job (jobid serial primary key, jobname text);
  create function cron.schedule(a text, b text, c text) returns bigint language sql as $$ insert into cron.job(jobname) values (a) returning jobid $$;
  create function cron.unschedule(id int) returns boolean language sql as $$ delete from cron.job where jobid = id returning true $$;
  create publication supabase_realtime;
  create table public.wa_log (id serial, number text, text text, at timestamptz default now());
  grant usage on schema public, auth to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
`;

export async function createTestDb(options = {}) {
  const db = new PGlite(options);
  await db.exec(STUBS);

  const dir = path.join(ROOT, 'supabase', 'migrations');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    // PGlite não tem pg_net/pg_cron de verdade (o cron é stub acima).
    await db.exec(readFileSync(path.join(dir, file), 'utf8').replace(/^create extension.*$/gm, ''));
  }

  // WhatsApp: em vez de chamar a uazapi, grava em wa_log pra conferir o texto.
  await db.exec(`create or replace function public.acai_send_whatsapp(p_number text, p_text text) returns void
    language sql as $$ insert into public.wa_log(number, text) values (p_number, p_text) $$`);

  await db.exec(readFileSync(path.join(ROOT, 'supabase', 'seed_mix.sql'), 'utf8'));
  // Loja aberta o dia todo pra dar pra testar pedido a qualquer hora.
  await db.exec(`update acai_business_hours set opens_at = '00:00', closes_at = '23:59:59'`);
  return db;
}
