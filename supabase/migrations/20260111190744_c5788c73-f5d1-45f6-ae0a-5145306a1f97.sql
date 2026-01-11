-- Drop existing patient policies
DROP POLICY IF EXISTS "Authenticated users can view patients" ON public.patients;
DROP POLICY IF EXISTS "Authenticated users can insert patients" ON public.patients;
DROP POLICY IF EXISTS "Authenticated users can update patients" ON public.patients;
DROP POLICY IF EXISTS "Admins can delete patients" ON public.patients;

-- Create helper function to check if user has relationship with patient
CREATE OR REPLACE FUNCTION public.can_access_patient(_patient_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    -- User created the patient
    SELECT 1 FROM public.patients WHERE id = _patient_id AND created_by = auth.uid()
    UNION
    -- User has an encounter with the patient
    SELECT 1 FROM public.encounters WHERE patient_id = _patient_id AND provider_id = auth.uid()
  )
$$;

-- Admins can view all patients
CREATE POLICY "Admins can view all patients"
ON public.patients
FOR SELECT
USING (has_role(auth.uid(), 'admin'::app_role));

-- Users can view patients they created or have encounters with
CREATE POLICY "Users can view own patients"
ON public.patients
FOR SELECT
USING (can_access_patient(id));

-- Any authenticated user with a role can create patients (they become the creator)
CREATE POLICY "Users with roles can insert patients"
ON public.patients
FOR INSERT
WITH CHECK (has_any_role(auth.uid()) AND (created_by IS NULL OR created_by = auth.uid()));

-- Users can update patients they created or have encounters with
CREATE POLICY "Users can update own patients"
ON public.patients
FOR UPDATE
USING (can_access_patient(id) OR has_role(auth.uid(), 'admin'::app_role));

-- Only admins can delete patients
CREATE POLICY "Admins can delete patients"
ON public.patients
FOR DELETE
USING (has_role(auth.uid(), 'admin'::app_role));

-- Update encounters policies to be more restrictive for non-admins
DROP POLICY IF EXISTS "Users with roles can view encounters" ON public.encounters;

-- Admins can view all encounters
CREATE POLICY "Admins can view all encounters"
ON public.encounters
FOR SELECT
USING (has_role(auth.uid(), 'admin'::app_role));

-- Providers can view their own encounters
CREATE POLICY "Providers can view own encounters"
ON public.encounters
FOR SELECT
USING (provider_id = auth.uid());

-- Update notes policies
DROP POLICY IF EXISTS "Users with roles can view notes" ON public.notes;

-- Admins can view all notes
CREATE POLICY "Admins can view all notes"
ON public.notes
FOR SELECT
USING (has_role(auth.uid(), 'admin'::app_role));

-- Users can view notes they created
CREATE POLICY "Users can view own notes"
ON public.notes
FOR SELECT
USING (created_by = auth.uid());

-- Update transcripts policies
DROP POLICY IF EXISTS "Users with roles can view transcripts" ON public.transcripts;
DROP POLICY IF EXISTS "Users with roles can insert transcripts" ON public.transcripts;

-- Admins can view all transcripts
CREATE POLICY "Admins can view all transcripts"
ON public.transcripts
FOR SELECT
USING (has_role(auth.uid(), 'admin'::app_role));

-- Users can view transcripts for encounters they own
CREATE POLICY "Users can view own transcripts"
ON public.transcripts
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.encounters 
    WHERE encounters.id = transcripts.encounter_id 
    AND encounters.provider_id = auth.uid()
  )
);

-- Users can insert transcripts for their own encounters
CREATE POLICY "Users can insert own transcripts"
ON public.transcripts
FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.encounters 
    WHERE encounters.id = encounter_id 
    AND encounters.provider_id = auth.uid()
  )
);

-- Update problem_list policies
DROP POLICY IF EXISTS "Users with roles can manage problem list" ON public.problem_list;
DROP POLICY IF EXISTS "Users with roles can view problem list" ON public.problem_list;

-- Admins can manage all problem list entries
CREATE POLICY "Admins can manage problem list"
ON public.problem_list
FOR ALL
USING (has_role(auth.uid(), 'admin'::app_role));

-- Users can view problem list for patients they have access to
CREATE POLICY "Users can view own patient problems"
ON public.problem_list
FOR SELECT
USING (can_access_patient(patient_id));

-- Users can manage problem list for patients they have access to
CREATE POLICY "Users can manage own patient problems"
ON public.problem_list
FOR ALL
USING (can_access_patient(patient_id));