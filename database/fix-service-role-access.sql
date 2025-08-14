-- Fix: Grant service role explicit access to pro_key table
-- The current RLS policy is blocking even the service role

-- First, grant basic table permissions to service_role
GRANT ALL PRIVILEGES ON TABLE public.pro_key TO service_role;

-- Drop the existing restrictive policy
DROP POLICY IF EXISTS "Block all public access to pro_key" ON public.pro_key;

-- Create a new policy that allows service_role but blocks public access
CREATE POLICY "Allow service_role, block public access" 
ON public.pro_key 
FOR ALL 
TO public
USING (auth.role() = 'service_role')
WITH CHECK (auth.role() = 'service_role');

-- Alternative approach: Create separate policies for different roles
-- DROP POLICY IF EXISTS "Allow service_role, block public access" ON public.pro_key;

-- CREATE POLICY "Block anon and authenticated users" 
-- ON public.pro_key 
-- FOR ALL 
-- TO anon, authenticated
-- USING (false)
-- WITH CHECK (false);

-- CREATE POLICY "Allow service role full access" 
-- ON public.pro_key 
-- FOR ALL 
-- TO service_role
-- USING (true)
-- WITH CHECK (true);

-- Verify the fix by checking policies
SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check 
FROM pg_policies 
WHERE tablename = 'pro_key';
