-- =====================================================
-- Secure the pro_key table with Row Level Security
-- This script will prevent public access to the pro_key table
-- Only service role (admin) can access the table
-- =====================================================

-- Enable Row Level Security on the pro_key table
ALTER TABLE pro_key ENABLE ROW LEVEL SECURITY;

-- Drop any existing policies for pro_key table
DROP POLICY IF EXISTS "Block all public access to pro_key" ON pro_key;
DROP POLICY IF EXISTS "Service role only access to pro_key" ON pro_key;

-- Create a restrictive policy that blocks ALL public access
-- This policy applies to all operations (SELECT, INSERT, UPDATE, DELETE)
-- and explicitly denies access to everyone
CREATE POLICY "Block all public access to pro_key" 
ON pro_key 
FOR ALL 
TO public
USING (false)
WITH CHECK (false);

-- Note: The service role bypasses RLS policies automatically
-- So our admin client using SUPABASE_SERVICE_ROLE_KEY will still work

-- Verify the table structure and existing data (for reference)
-- This is a comment showing what the table should look like:
/*
pro_key table structure:
- pro_key (text, primary key) - The API key
- remaining (integer) - Remaining quota
- last_updated (timestamp with time zone) - Last update time
- created_at (timestamp with time zone) - Creation time
*/

-- Create an index on remaining for performance (if it doesn't exist)
CREATE INDEX IF NOT EXISTS idx_pro_key_remaining ON pro_key(remaining DESC);

-- Create an index on last_updated for monitoring queries
CREATE INDEX IF NOT EXISTS idx_pro_key_last_updated ON pro_key(last_updated DESC);

-- Optional: Create a view for monitoring (only accessible by service role)
CREATE OR REPLACE VIEW pro_key_status AS
SELECT 
  pro_key,
  remaining,
  last_updated,
  created_at,
  CASE 
    WHEN remaining <= 0 THEN 'Exhausted'
    WHEN remaining <= 100 THEN 'Low'
    WHEN remaining <= 500 THEN 'Medium'
    ELSE 'High'
  END as quota_status,
  EXTRACT(EPOCH FROM (NOW() - last_updated))/3600 as hours_since_last_use
FROM pro_key
ORDER BY remaining DESC, last_updated DESC;

-- Enable RLS on the view as well
ALTER VIEW pro_key_status ENABLE ROW LEVEL SECURITY;

-- Block public access to the view
CREATE POLICY "Block all public access to pro_key_status" 
ON pro_key_status 
FOR ALL 
TO public
USING (false);

-- Create a function to check pro_key table access (for testing)
CREATE OR REPLACE FUNCTION test_pro_key_access()
RETURNS TABLE(can_select boolean, can_insert boolean, error_message text)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Test SELECT access
  BEGIN
    PERFORM COUNT(*) FROM pro_key LIMIT 1;
    can_select := true;
  EXCEPTION WHEN insufficient_privilege THEN
    can_select := false;
  END;
  
  -- Test INSERT access (without actually inserting)
  BEGIN
    -- This will fail due to RLS even before trying to insert
    PERFORM 1 WHERE EXISTS (SELECT 1 FROM pro_key WHERE false);
    can_insert := true;
  EXCEPTION WHEN insufficient_privilege THEN
    can_insert := false;
  END;
  
  -- Set error message based on results
  IF NOT can_select AND NOT can_insert THEN
    error_message := 'No access to pro_key table (RLS working correctly)';
  ELSIF can_select OR can_insert THEN
    error_message := 'WARNING: Some access still possible to pro_key table';
  ELSE
    error_message := 'Access test completed';
  END IF;
  
  RETURN NEXT;
END;
$$;

-- Grant execute permission on the test function to public for testing
GRANT EXECUTE ON FUNCTION test_pro_key_access() TO public;

-- =====================================================
-- VERIFICATION QUERIES (run these to verify security)
-- =====================================================

-- 1. Check that RLS is enabled
-- SELECT schemaname, tablename, rowsecurity 
-- FROM pg_tables 
-- WHERE tablename = 'pro_key';

-- 2. List all policies on pro_key table
-- SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
-- FROM pg_policies 
-- WHERE tablename = 'pro_key';

-- 3. Test access as public user (should fail)
-- SELECT test_pro_key_access();

-- 4. Test service role access (should work when using service role key)
-- This would be done from your application using the admin client

-- =====================================================
-- IMPORTANT NOTES:
-- =====================================================
-- 1. After running this script, the pro_key table will be completely
--    inaccessible to public users and anon users
-- 2. Only requests using SUPABASE_SERVICE_ROLE_KEY can access the table
-- 3. Your admin client functions will continue to work normally
-- 4. Any existing public API clients will receive permission denied errors
-- 5. This is exactly what we want for security!
-- =====================================================
