-- =====================================================
-- ⛔ DO NOT APPLY THIS FILE AS-IS. NOT APPLIED TO PROD. (verified 2026-06-22)
--
-- Skeptic probe of the live CTH DB (project dtdqopjdxwfvtyrnygdt, via mgmt API):
--   * is_admin() / is_owner() functions DO NOT EXIST in prod -> this migration
--     was never run.
--   * RLS IS already enabled on admin_users / vendor_applications / mail_messages /
--     mail_optout / wa_threads, governed by OLDER, WORKING policies that check
--     plain membership: EXISTS (select 1 from admin_users where id = auth.uid()).
--     Those policies have NO role-enum check, so there is NO operator lockout.
--   * The app reads/writes these tables via the SERVICE ROLE client
--     (createAdminClient), which bypasses RLS entirely. RLS here is defence in
--     depth, not load-bearing.
--
-- Therefore the `role IN ('admin','owner')` check below is a latent bug ONLY in
-- this unran file (the app's real enum is 'owner'|'operator'|'viewer'). Applying
-- this file would REPLACE the working membership policies with role-gated ones
-- that exclude 'operator' -> a NEW breakage, not a fix. If RLS role-hardening is
-- ever wanted, treat it as a deliberate Tier-1 change with its own spec + test,
-- fix the enum to ('owner','operator') first, and verify against the live app's
-- service-role bypass. Until then: leave prod's membership policies untouched.
-- =====================================================
-- Migration V13: Row Level Security policies for sensitive surfaces
-- Run AFTER Streams B, C, G land the underlying tables/columns.
-- Idempotent + re-runnable. Defines policies ONLY (does not ENABLE RLS).
--
-- Identity model:
--   auth.uid() = the caller's auth.users id (NULL for service role / anon).
--   admin_users.role IN ('admin','owner') marks a privileged actor.
--   "Owner" = admin_users row where id = auth.uid() (self-read for own row).
--   Service role bypasses RLS by default; these policies govern anon + authed clients.
--
-- Tables governed:
--   mail_messages          (Stream B)  - admin-only SELECT/INSERT/UPDATE
--   mail_optout            (Stream B)  - admin-only SELECT/INSERT, no UPDATE/DELETE
--   wa_threads             (Stream C)  - admin-only ALL
--   admin_users.role       (Stream G)  - SELECT self + admin, UPDATE owner-only
--   vendor_applications    (existing)  - new columns reviewed_by, dup_marker,
--                                        completeness_score (SELECT admin, UPDATE admin)
-- =====================================================

-- ---------- helper: is the caller an admin? ----------
-- SECURITY DEFINER so the helper itself reads admin_users without RLS recursion.
-- STABLE because the result depends only on auth.uid() within a transaction.
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.admin_users
    WHERE id = auth.uid()
      AND role IN ('admin','owner')
  );
$$;

-- ---------- helper: is the caller an owner (top-level admin)? ----------
CREATE OR REPLACE FUNCTION public.is_owner()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.admin_users
    WHERE id = auth.uid()
      AND role = 'owner'
  );
$$;

-- =====================================================
-- mail_messages: admin-only SELECT / INSERT / UPDATE.
-- No DELETE policy = no client can delete (service role still can).
-- =====================================================
DROP POLICY IF EXISTS "mail_messages admin select" ON public.mail_messages;
CREATE POLICY "mail_messages admin select"
  ON public.mail_messages
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

DROP POLICY IF EXISTS "mail_messages admin insert" ON public.mail_messages;
CREATE POLICY "mail_messages admin insert"
  ON public.mail_messages
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "mail_messages admin update" ON public.mail_messages;
CREATE POLICY "mail_messages admin update"
  ON public.mail_messages
  FOR UPDATE
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- =====================================================
-- mail_optout: admin-only SELECT / INSERT. No UPDATE, no DELETE.
-- Opt-out is append-only by design (legal record).
-- =====================================================
DROP POLICY IF EXISTS "mail_optout admin select" ON public.mail_optout;
CREATE POLICY "mail_optout admin select"
  ON public.mail_optout
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

DROP POLICY IF EXISTS "mail_optout admin insert" ON public.mail_optout;
CREATE POLICY "mail_optout admin insert"
  ON public.mail_optout
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin());

-- Intentionally no UPDATE or DELETE policies on mail_optout.

-- =====================================================
-- wa_threads: admin-only for all operations.
-- =====================================================
DROP POLICY IF EXISTS "wa_threads admin select" ON public.wa_threads;
CREATE POLICY "wa_threads admin select"
  ON public.wa_threads
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

DROP POLICY IF EXISTS "wa_threads admin insert" ON public.wa_threads;
CREATE POLICY "wa_threads admin insert"
  ON public.wa_threads
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "wa_threads admin update" ON public.wa_threads;
CREATE POLICY "wa_threads admin update"
  ON public.wa_threads
  FOR UPDATE
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "wa_threads admin delete" ON public.wa_threads;
CREATE POLICY "wa_threads admin delete"
  ON public.wa_threads
  FOR DELETE
  TO authenticated
  USING (public.is_admin());

-- =====================================================
-- admin_users:
--   SELECT: self (id = auth.uid()) OR any admin
--   INSERT: owner-only (bootstrap is service-role; new admins added by owner)
--   UPDATE: owner-only (role escalation must require owner)
--   DELETE: owner-only
-- =====================================================
DROP POLICY IF EXISTS "admin_users self or admin select" ON public.admin_users;
CREATE POLICY "admin_users self or admin select"
  ON public.admin_users
  FOR SELECT
  TO authenticated
  USING (
    id = auth.uid()
    OR public.is_admin()
  );

DROP POLICY IF EXISTS "admin_users owner insert" ON public.admin_users;
CREATE POLICY "admin_users owner insert"
  ON public.admin_users
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_owner());

DROP POLICY IF EXISTS "admin_users owner update" ON public.admin_users;
CREATE POLICY "admin_users owner update"
  ON public.admin_users
  FOR UPDATE
  TO authenticated
  USING (public.is_owner())
  WITH CHECK (public.is_owner());

DROP POLICY IF EXISTS "admin_users owner delete" ON public.admin_users;
CREATE POLICY "admin_users owner delete"
  ON public.admin_users
  FOR DELETE
  TO authenticated
  USING (public.is_owner());

-- =====================================================
-- vendor_applications (existing table, new sensitive columns from Stream G):
--   reviewed_by, dup_marker, completeness_score
--
-- The base table already has policies (defined elsewhere). These policies
-- gate SELECT/UPDATE specifically for admin-only access. Column-level RLS in
-- Postgres is enforced by GRANT, but RLS row policies + admin gate is the
-- pragmatic match for Supabase's auth model.
--
-- Note: replacing existing policies on vendor_applications would clobber
-- vendor self-read. We add admin-only policies that COEXIST with whatever
-- vendor-self policy lives in v7/v8. Use distinctly-named policies so the
-- previous ones survive.
-- =====================================================
DROP POLICY IF EXISTS "vendor_applications admin select" ON public.vendor_applications;
CREATE POLICY "vendor_applications admin select"
  ON public.vendor_applications
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

DROP POLICY IF EXISTS "vendor_applications admin update" ON public.vendor_applications;
CREATE POLICY "vendor_applications admin update"
  ON public.vendor_applications
  FOR UPDATE
  TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- =====================================================
-- Verification: list policies on the governed tables.
-- =====================================================
SELECT schemaname, tablename, policyname, cmd, roles
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'mail_messages',
    'mail_optout',
    'wa_threads',
    'admin_users',
    'vendor_applications'
  )
ORDER BY tablename, policyname;
