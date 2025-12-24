-- Fix search_path for update_updated_at_column function
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Fix search_path for generate_mrn function
CREATE OR REPLACE FUNCTION public.generate_mrn()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  new_mrn TEXT;
  mrn_exists BOOLEAN;
BEGIN
  LOOP
    new_mrn := 'MRN-' || LPAD(FLOOR(RANDOM() * 1000000)::TEXT, 6, '0');
    SELECT EXISTS(SELECT 1 FROM public.patients WHERE mrn = new_mrn) INTO mrn_exists;
    EXIT WHEN NOT mrn_exists;
  END LOOP;
  RETURN new_mrn;
END;
$$;