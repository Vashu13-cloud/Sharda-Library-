-- Sharda Library server-side extension storage.
-- This migration adds isolated tables and does not alter existing library_* tables.
-- Apply only after reviewing it against the target Supabase project.

CREATE TABLE IF NOT EXISTS public.library_server_backups (
  name text PRIMARY KEY,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.library_student_photos (
  id text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{32}$'),
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  image_data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.library_audit_events (
  id bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  event text NOT NULL,
  ip text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS library_audit_events_created_idx
  ON public.library_audit_events (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS library_student_photos_created_idx
  ON public.library_student_photos (created_at DESC);

-- These tables are accessed only through the authenticated Node.js server.
-- Do not add anon/authenticated policies or expose them through client-side Supabase APIs.
ALTER TABLE public.library_server_backups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.library_student_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.library_audit_events ENABLE ROW LEVEL SECURITY;
