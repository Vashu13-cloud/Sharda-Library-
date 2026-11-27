-- Sharda Library core schema for a NEW, EMPTY Supabase PostgreSQL database.
-- Safe/idempotent for repeated setup on the same fresh project.
-- This migration creates tables only; it does not drop, truncate, or modify existing rows.
-- Apply 000_core_schema.sql first, then 001_server_extensions.sql.

CREATE TABLE IF NOT EXISTS public.library_meta (
  id integer PRIMARY KEY CHECK (id = 1),
  schema_version integer NOT NULL DEFAULT 1,
  data_version bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.library_admin (
  id text PRIMARY KEY,
  password_salt text NOT NULL,
  password_hash text NOT NULL,
  mobile text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  password_changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.library_students (
  record_id text PRIMARY KEY,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.library_half_visits (
  record_id text PRIMARY KEY,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.library_booking_requests (
  record_id text PRIMARY KEY,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.library_seat_history (
  record_id text PRIMARY KEY,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.library_settings (
  setting_key text PRIMARY KEY,
  setting_value jsonb NOT NULL
);

-- Server-only access. Do not add anon/authenticated policies to these tables.
ALTER TABLE public.library_meta ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.library_admin ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.library_students ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.library_half_visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.library_booking_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.library_seat_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.library_settings ENABLE ROW LEVEL SECURITY;
