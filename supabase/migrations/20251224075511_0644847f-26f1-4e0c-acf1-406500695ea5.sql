-- Create enum for user roles
CREATE TYPE public.app_role AS ENUM ('admin', 'staff', 'provider');

-- Create enum for gender
CREATE TYPE public.gender_type AS ENUM ('Male', 'Female', 'Other');

-- Create enum for note types
CREATE TYPE public.note_type AS ENUM ('SOAP', 'H&P', 'Progress', 'Procedure');

-- Create enum for encounter status
CREATE TYPE public.encounter_status AS ENUM ('in_progress', 'completed', 'cancelled');

-- Create profiles table
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create user_roles table (separate from profiles for security)
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  role app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);

-- Create patients table
CREATE TABLE public.patients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mrn TEXT NOT NULL UNIQUE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  date_of_birth DATE NOT NULL,
  gender gender_type NOT NULL,
  phone TEXT,
  email TEXT,
  address TEXT,
  emergency_contact_name TEXT,
  emergency_contact_phone TEXT,
  insurance_provider TEXT,
  insurance_id TEXT,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create encounters table
CREATE TABLE public.encounters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID REFERENCES public.patients(id) ON DELETE CASCADE NOT NULL,
  provider_id UUID REFERENCES auth.users(id) NOT NULL,
  chief_complaint TEXT,
  status encounter_status NOT NULL DEFAULT 'in_progress',
  encounter_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create transcripts table for live transcription
CREATE TABLE public.transcripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  encounter_id UUID REFERENCES public.encounters(id) ON DELETE CASCADE NOT NULL,
  content TEXT NOT NULL,
  speaker TEXT,
  timestamp_start TIMESTAMPTZ,
  timestamp_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create notes table
CREATE TABLE public.notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  encounter_id UUID REFERENCES public.encounters(id) ON DELETE CASCADE NOT NULL,
  note_type note_type NOT NULL,
  content JSONB NOT NULL DEFAULT '{}',
  raw_content TEXT,
  is_finalized BOOLEAN NOT NULL DEFAULT false,
  created_by UUID REFERENCES auth.users(id) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create problem list table for tracking patient conditions
CREATE TABLE public.problem_list (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID REFERENCES public.patients(id) ON DELETE CASCADE NOT NULL,
  condition_name TEXT NOT NULL,
  icd_code TEXT,
  onset_date DATE,
  status TEXT DEFAULT 'active',
  is_chronic BOOLEAN DEFAULT false,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS on all tables
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.encounters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transcripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.problem_list ENABLE ROW LEVEL SECURITY;

-- Security definer function to check roles
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role app_role)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id
      AND role = _role
  )
$$;

-- Function to check if user has any valid role
CREATE OR REPLACE FUNCTION public.has_any_role(_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id
  )
$$;

-- RLS Policies for profiles
CREATE POLICY "Users can view own profile"
  ON public.profiles FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own profile"
  ON public.profiles FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Admins can view all profiles"
  ON public.profiles FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'));

-- RLS Policies for user_roles
CREATE POLICY "Users can view own roles"
  ON public.user_roles FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Admins can manage all roles"
  ON public.user_roles FOR ALL
  USING (public.has_role(auth.uid(), 'admin'));

-- RLS Policies for patients (all authenticated staff can view/manage)
CREATE POLICY "Authenticated users can view patients"
  ON public.patients FOR SELECT
  USING (public.has_any_role(auth.uid()));

CREATE POLICY "Authenticated users can insert patients"
  ON public.patients FOR INSERT
  WITH CHECK (public.has_any_role(auth.uid()));

CREATE POLICY "Authenticated users can update patients"
  ON public.patients FOR UPDATE
  USING (public.has_any_role(auth.uid()));

CREATE POLICY "Admins can delete patients"
  ON public.patients FOR DELETE
  USING (public.has_role(auth.uid(), 'admin'));

-- RLS Policies for encounters
CREATE POLICY "Users with roles can view encounters"
  ON public.encounters FOR SELECT
  USING (public.has_any_role(auth.uid()));

CREATE POLICY "Providers can create encounters"
  ON public.encounters FOR INSERT
  WITH CHECK (public.has_role(auth.uid(), 'provider') AND auth.uid() = provider_id);

CREATE POLICY "Providers can update own encounters"
  ON public.encounters FOR UPDATE
  USING (auth.uid() = provider_id OR public.has_role(auth.uid(), 'admin'));

-- RLS Policies for transcripts
CREATE POLICY "Users with roles can view transcripts"
  ON public.transcripts FOR SELECT
  USING (public.has_any_role(auth.uid()));

CREATE POLICY "Users with roles can insert transcripts"
  ON public.transcripts FOR INSERT
  WITH CHECK (public.has_any_role(auth.uid()));

-- RLS Policies for notes
CREATE POLICY "Users with roles can view notes"
  ON public.notes FOR SELECT
  USING (public.has_any_role(auth.uid()));

CREATE POLICY "Providers can create notes"
  ON public.notes FOR INSERT
  WITH CHECK (public.has_role(auth.uid(), 'provider') AND auth.uid() = created_by);

CREATE POLICY "Note creators can update notes"
  ON public.notes FOR UPDATE
  USING (auth.uid() = created_by OR public.has_role(auth.uid(), 'admin'));

-- RLS Policies for problem_list
CREATE POLICY "Users with roles can view problem list"
  ON public.problem_list FOR SELECT
  USING (public.has_any_role(auth.uid()));

CREATE POLICY "Users with roles can manage problem list"
  ON public.problem_list FOR ALL
  USING (public.has_any_role(auth.uid()));

-- Function to update timestamps
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for updated_at
CREATE TRIGGER update_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_patients_updated_at
  BEFORE UPDATE ON public.patients
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_encounters_updated_at
  BEFORE UPDATE ON public.encounters
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_notes_updated_at
  BEFORE UPDATE ON public.notes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_problem_list_updated_at
  BEFORE UPDATE ON public.problem_list
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Function to create profile on user signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (user_id, full_name, email)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data ->> 'full_name', NEW.email),
    NEW.email
  );
  -- Default new users to 'staff' role - admins can upgrade
  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, 'staff');
  RETURN NEW;
END;
$$;

-- Trigger to create profile on signup
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Function to generate MRN
CREATE OR REPLACE FUNCTION public.generate_mrn()
RETURNS TEXT
LANGUAGE plpgsql
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