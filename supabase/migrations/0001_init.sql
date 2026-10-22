-- ============================================================
-- Migration: 0001_init.sql
-- Description: Initial schema for the AI Task Assistant.
--   Creates custom enums, the `users`, `tasks`, and `messages`
--   tables, plus Row Level Security (RLS) policies.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Custom ENUM types
-- ------------------------------------------------------------

-- Status lifecycle for a task.
CREATE TYPE task_status AS ENUM ('todo', 'in_progress', 'done');

-- Priority levels for a task.
CREATE TYPE task_priority AS ENUM ('low', 'medium', 'high');

-- Roles allowed in a chat message (mirrors OpenAI chat roles).
CREATE TYPE message_role AS ENUM ('user', 'assistant', 'system');

-- ------------------------------------------------------------
-- 2. users table
--    NOTE: In a full Supabase Auth setup, `id` would reference
--    auth.users(id). Here we keep it standalone for simplicity
--    and back it with a trigger that syncs auth.users -> public.users.
-- ------------------------------------------------------------

CREATE TABLE public.users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.users IS 'Application-level user profile records.';

-- Auto-create a public.users row whenever a new auth user signs up.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.users (id, email)
  VALUES (new.id, new.email)
  ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email;
  RETURN new;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ------------------------------------------------------------
-- 3. tasks table
-- ------------------------------------------------------------

CREATE TABLE public.tasks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  title       text NOT NULL,
  status      task_status NOT NULL DEFAULT 'todo',
  priority    task_priority NOT NULL DEFAULT 'medium',
  due_date    timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.tasks IS 'User-created tasks managed via REST and the AI assistant.';
COMMENT ON COLUMN public.tasks.due_date IS 'Optional deadline for the task; null means no due date.';

-- Fast lookups per user, ordered by creation time.
CREATE INDEX tasks_user_id_created_at_idx ON public.tasks (user_id, created_at DESC);

-- ------------------------------------------------------------
-- 4. messages table
-- ------------------------------------------------------------

CREATE TABLE public.messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role        message_role NOT NULL,
  content     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.messages IS 'Persistent chat history between the user and the AI assistant.';

CREATE INDEX messages_user_id_created_at_idx ON public.messages (user_id, created_at ASC);

-- ------------------------------------------------------------
-- 5. Row Level Security (RLS)
--    Enable RLS and restrict access to the row owner.
--    Assumes requests are made with a Supabase Auth JWT via
--    `supabase.auth.getUser()` on the server; for direct client
--    access, `auth.uid()` maps to the JWT `sub` claim.
-- ------------------------------------------------------------

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

-- users: a user can only read/update their own profile.
CREATE POLICY users_select_own ON public.users
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY users_update_own ON public.users
  FOR UPDATE USING (auth.uid() = id);

-- tasks: full CRUD scoped to the owner.
CREATE POLICY tasks_select_own ON public.tasks
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY tasks_insert_own ON public.tasks
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY tasks_update_own ON public.tasks
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY tasks_delete_own ON public.tasks
  FOR DELETE USING (auth.uid() = user_id);

-- messages: read/create scoped to the owner.
CREATE POLICY messages_select_own ON public.messages
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY messages_insert_own ON public.messages
  FOR INSERT WITH CHECK (auth.uid() = user_id);
