-- Durable authentication and request-throttling state for serverless/multi-instance hosting.
-- Additive migration: does not alter or delete existing student, fee, booking, or admin rows.
CREATE TABLE IF NOT EXISTS public.library_auth_state (
  state_key text PRIMARY KEY,
  state_value jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS library_auth_state_expiry_idx
  ON public.library_auth_state (expires_at);

CREATE TABLE IF NOT EXISTS public.library_rate_limits (
  bucket_key text PRIMARY KEY,
  hit_count integer NOT NULL CHECK (hit_count >= 0),
  window_started_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS library_rate_limits_expiry_idx
  ON public.library_rate_limits (expires_at);

ALTER TABLE public.library_auth_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.library_rate_limits ENABLE ROW LEVEL SECURITY;
-- No anon/authenticated policies: only the private server-side PostgreSQL connection may access these tables.
