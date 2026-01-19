-- Allow providers to delete their own encounters
CREATE POLICY "Providers can delete own encounters"
ON public.encounters
FOR DELETE
USING (auth.uid() = provider_id OR has_role(auth.uid(), 'admin'::app_role));