-- =====================================================
-- RBAC for Admin Portal, Migration v12
-- Adds role (owner|operator|viewer) to admin_users.
-- Run in Supabase SQL Editor (CTH Supabase, separate account).
-- =====================================================

-- 1. Add the column with a safe default. Operators by default.
ALTER TABLE admin_users
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'operator';

-- 2. Constrain to a known enum-like set.
ALTER TABLE admin_users
  DROP CONSTRAINT IF EXISTS admin_users_role_check;

ALTER TABLE admin_users
  ADD CONSTRAINT admin_users_role_check
  CHECK (role IN ('owner', 'operator', 'viewer'));

-- 3. Index for quick role lookups when surfacing the chip.
CREATE INDEX IF NOT EXISTS idx_admin_users_role ON admin_users(role);

-- 4. Backfill known owners. Email match is case-insensitive,
--    safe to re-run, no-op when already owner.
UPDATE admin_users
SET role = 'owner'
WHERE LOWER(email) IN (
  'taonac96@gmail.com',
  'taona@zanii.agency',
  'samreen@globalcuisine.co.za'
);

-- 5. Everyone else stays 'operator' (the default).
--    No DDL on auth.users. No phantom stalls table.

-- =====================================================
-- AFTER RUNNING THIS:
--   Verify with:
--     SELECT email, role FROM admin_users ORDER BY role, email;
--   If a known owner is missing, INSERT them as admin first,
--   then UPDATE their role to 'owner'.
-- =====================================================
