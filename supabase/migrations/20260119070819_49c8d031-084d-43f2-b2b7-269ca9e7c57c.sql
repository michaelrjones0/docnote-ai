-- Drop the existing restrictive INSERT policy for notes
DROP POLICY IF EXISTS "Providers can create notes" ON public.notes;

-- Create a new policy that allows any authenticated user with a role to create notes
CREATE POLICY "Users with roles can create notes"
ON public.notes
FOR INSERT
WITH CHECK (
  has_any_role(auth.uid()) 
  AND auth.uid() = created_by
);