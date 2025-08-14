-- FINAL FIX: The auth.role() approach doesn't work properly
-- We need to disable RLS checks for service role completely

-- Drop all existing policies
DROP POLICY IF EXISTS "Allow service_role, block public access" ON public.pro_key;
DROP POLICY IF EXISTS "Block anon access" ON public.pro_key;
DROP POLICY IF EXISTS "Block authenticated access" ON public.pro_key;  
DROP POLICY IF EXISTS "Service role access" ON public.pro_key;

-- Create a simple policy that blocks only anon and authenticated users
-- Service role will bypass RLS completely with proper grants
CREATE POLICY "Block public users only"
ON public.pro_key
FOR ALL
TO anon, authenticated
USING (false)
WITH CHECK (false);

-- Grant explicit permissions to service_role (bypasses RLS)
GRANT ALL PRIVILEGES ON TABLE public.pro_key TO service_role;

-- Verify the setup
SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check 
FROM pg_policies 
WHERE tablename = 'pro_key';
