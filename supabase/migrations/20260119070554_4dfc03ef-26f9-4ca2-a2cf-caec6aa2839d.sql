-- Drop the existing restrictive INSERT policy
DROP POLICY IF EXISTS "Providers can create encounters" ON public.encounters;

-- Create a new policy that allows any authenticated user with a role to create encounters
CREATE POLICY "Users with roles can create encounters"
ON public.encounters
FOR INSERT
WITH CHECK (
  has_any_role(auth.uid()) 
  AND auth.uid() = provider_id
);