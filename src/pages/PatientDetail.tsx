import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { useToast } from '@/hooks/use-toast';
import { PatientEditForm } from '@/components/patients/PatientEditForm';
import { 
  ArrowLeft, 
  Loader2, 
  User, 
  Calendar, 
  Phone, 
  Mail, 
  MapPin,
  AlertCircle,
  Activity,
  FileText,
  Clock,
  Pencil
} from 'lucide-react';
import { format } from 'date-fns';

interface Patient {
  id: string;
  mrn: string;
  first_name: string;
  last_name: string;
  date_of_birth: string;
  gender: string;
  phone?: string;
  email?: string;
  address?: string;
  emergency_contact_name?: string;
  emergency_contact_phone?: string;
  insurance_provider?: string;
  insurance_id?: string;
}

interface Encounter {
  id: string;
  encounter_date: string;
  chief_complaint: string | null;
  status: string;
}

interface Problem {
  id: string;
  condition_name: string;
  icd_code: string | null;
  onset_date: string | null;
  status: string | null;
  is_chronic: boolean | null;
  notes: string | null;
}

export default function PatientDetail() {
  const { patientId } = useParams<{ patientId: string }>();
  const [patient, setPatient] = useState<Patient | null>(null);
  const [encounters, setEncounters] = useState<Encounter[]>([]);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isEditOpen, setIsEditOpen] = useState(false);
  
  const { user, isLoading: authLoading } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/auth');
    }
  }, [user, authLoading, navigate]);

  useEffect(() => {
    if (user && patientId) {
      fetchPatientData();
    }
  }, [user, patientId]);

  const fetchPatientData = async () => {
    setIsLoading(true);
    
    // Fetch patient, encounters, and problems in parallel
    const [patientRes, encountersRes, problemsRes] = await Promise.all([
      supabase
        .from('patients')
        .select('*')
        .eq('id', patientId)
        .maybeSingle(),
      supabase
        .from('encounters')
        .select('id, encounter_date, chief_complaint, status')
        .eq('patient_id', patientId)
        .order('encounter_date', { ascending: false }),
      supabase
        .from('problem_list')
        .select('*')
        .eq('patient_id', patientId)
        .order('created_at', { ascending: false })
    ]);

    if (patientRes.error) {
      toast({ title: 'Error loading patient', description: patientRes.error.message, variant: 'destructive' });
    } else if (!patientRes.data) {
      toast({ title: 'Patient not found', variant: 'destructive' });
      navigate('/patients');
      return;
    } else {
      setPatient(patientRes.data);
    }

    if (encountersRes.error) {
      toast({ title: 'Error loading encounters', description: encountersRes.error.message, variant: 'destructive' });
    } else {
      setEncounters(encountersRes.data || []);
    }

    if (problemsRes.error) {
      toast({ title: 'Error loading problem list', description: problemsRes.error.message, variant: 'destructive' });
    } else {
      setProblems(problemsRes.data || []);
    }

    setIsLoading(false);
  };

  const calculateAge = (dob: string) => {
    const today = new Date();
    const birthDate = new Date(dob);
    let age = today.getFullYear() - birthDate.getFullYear();
    const m = today.getMonth() - birthDate.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
      age--;
    }
    return age;
  };

  const getStatusBadgeVariant = (status: string) => {
    switch (status) {
      case 'completed': return 'default';
      case 'in_progress': return 'secondary';
      case 'cancelled': return 'destructive';
      case 'active': return 'default';
      case 'resolved': return 'outline';
      default: return 'secondary';
    }
  };

  if (authLoading || isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!patient) {
    return null;
  }

  const activeProblems = problems.filter(p => p.status === 'active');
  const chronicConditions = problems.filter(p => p.is_chronic);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card sticky top-0 z-10">
        <div className="container mx-auto px-4 py-4 flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/patients')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-xl font-semibold">{patient.last_name}, {patient.first_name}</h1>
            <p className="text-sm text-muted-foreground font-mono">{patient.mrn}</p>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 space-y-6">
        {/* Demographics Section */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <User className="h-5 w-5" />
              Demographics
            </CardTitle>
            <Button variant="outline" size="sm" onClick={() => setIsEditOpen(true)}>
              <Pencil className="h-4 w-4 mr-2" />
              Edit
            </Button>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              <div className="space-y-4">
                <div>
                  <p className="text-sm text-muted-foreground">Full Name</p>
                  <p className="font-medium">{patient.first_name} {patient.last_name}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <p className="text-sm text-muted-foreground">Date of Birth</p>
                    <p className="font-medium">
                      {format(new Date(patient.date_of_birth), 'MMM d, yyyy')} ({calculateAge(patient.date_of_birth)} years old)
                    </p>
                  </div>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Gender</p>
                  <p className="font-medium">{patient.gender}</p>
                </div>
              </div>

              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <Phone className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <p className="text-sm text-muted-foreground">Phone</p>
                    <p className="font-medium">{patient.phone || 'Not provided'}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Mail className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <p className="text-sm text-muted-foreground">Email</p>
                    <p className="font-medium">{patient.email || 'Not provided'}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <MapPin className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <p className="text-sm text-muted-foreground">Address</p>
                    <p className="font-medium">{patient.address || 'Not provided'}</p>
                  </div>
                </div>
              </div>

              <div className="space-y-4">
                <div>
                  <p className="text-sm text-muted-foreground">Emergency Contact</p>
                  <p className="font-medium">{patient.emergency_contact_name || 'Not provided'}</p>
                  {patient.emergency_contact_phone && (
                    <p className="text-sm text-muted-foreground">{patient.emergency_contact_phone}</p>
                  )}
                </div>
                <Separator />
                <div>
                  <p className="text-sm text-muted-foreground">Insurance Provider</p>
                  <p className="font-medium">{patient.insurance_provider || 'Not provided'}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Insurance ID</p>
                  <p className="font-medium font-mono">{patient.insurance_id || 'Not provided'}</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Problem List Section */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <AlertCircle className="h-5 w-5" />
                  Problem List
                </span>
                <Badge variant="secondary">{activeProblems.length} active</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {problems.length === 0 ? (
                <p className="text-muted-foreground text-center py-8">No problems documented</p>
              ) : (
                <div className="space-y-3">
                  {problems.map((problem) => (
                    <div 
                      key={problem.id} 
                      className="p-3 rounded-lg border bg-card hover:bg-muted/50 transition-colors"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <p className="font-medium">{problem.condition_name}</p>
                            {problem.is_chronic && (
                              <Badge variant="outline" className="text-xs">Chronic</Badge>
                            )}
                          </div>
                          {problem.icd_code && (
                            <p className="text-xs font-mono text-muted-foreground">{problem.icd_code}</p>
                          )}
                          {problem.onset_date && (
                            <p className="text-sm text-muted-foreground mt-1">
                              Onset: {format(new Date(problem.onset_date), 'MMM d, yyyy')}
                            </p>
                          )}
                          {problem.notes && (
                            <p className="text-sm text-muted-foreground mt-1">{problem.notes}</p>
                          )}
                        </div>
                        <Badge variant={getStatusBadgeVariant(problem.status || 'active')}>
                          {problem.status || 'active'}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Visit History Section */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <Activity className="h-5 w-5" />
                  Visit History
                </span>
                <Badge variant="secondary">{encounters.length} visits</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {encounters.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-muted-foreground mb-4">No visits recorded</p>
                  <Button onClick={() => navigate(`/encounters?patientId=${patient.id}`)}>
                    Start New Encounter
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  {encounters.map((encounter) => (
                    <div 
                      key={encounter.id}
                      className="p-3 rounded-lg border bg-card hover:bg-muted/50 transition-colors cursor-pointer"
                      onClick={() => navigate(`/encounters?encounterId=${encounter.id}`)}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <Clock className="h-4 w-4 text-muted-foreground" />
                            <p className="font-medium">
                              {format(new Date(encounter.encounter_date), 'MMM d, yyyy h:mm a')}
                            </p>
                          </div>
                          {encounter.chief_complaint && (
                            <p className="text-sm text-muted-foreground mt-1 flex items-center gap-2">
                              <FileText className="h-3 w-3" />
                              {encounter.chief_complaint}
                            </p>
                          )}
                        </div>
                        <Badge variant={getStatusBadgeVariant(encounter.status)}>
                          {encounter.status.replace('_', ' ')}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Quick Summary */}
        {chronicConditions.length > 0 && (
          <Card className="border-amber-500/50 bg-amber-500/5">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2 text-amber-600">
                <AlertCircle className="h-4 w-4" />
                Chronic Conditions Summary
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {chronicConditions.map((condition) => (
                  <Badge key={condition.id} variant="outline" className="border-amber-500/50">
                    {condition.condition_name}
                    {condition.icd_code && ` (${condition.icd_code})`}
                  </Badge>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Action Buttons */}
        <div className="flex gap-4">
          <Button onClick={() => navigate(`/encounters?patientId=${patient.id}`)}>
            Start New Encounter
          </Button>
        </div>
      </main>

      {/* Edit Form Dialog */}
      <PatientEditForm
        patient={patient}
        open={isEditOpen}
        onOpenChange={setIsEditOpen}
        onSuccess={fetchPatientData}
      />
    </div>
  );
}
