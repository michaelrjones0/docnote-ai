import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Search, Loader2, User } from 'lucide-react';

interface Patient {
  id: string;
  first_name: string;
  last_name: string;
  mrn: string;
  gender: 'Male' | 'Female' | 'Other';
  date_of_birth: string;
}

interface PatientPickerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectPatient: (patient: Patient) => void;
}

export function PatientPickerModal({ open, onOpenChange, onSelectPatient }: PatientPickerModalProps) {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    if (open) {
      fetchPatients();
    }
  }, [open]);

  const fetchPatients = async () => {
    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from('patients')
        .select('id, first_name, last_name, mrn, gender, date_of_birth')
        .order('last_name', { ascending: true });

      if (error) throw error;
      setPatients(data || []);
    } catch (err) {
      console.error('Error fetching patients:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const filteredPatients = patients.filter(p => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    const fullName = `${p.first_name} ${p.last_name}`.toLowerCase();
    return fullName.includes(query) || p.mrn.toLowerCase().includes(query);
  });

  const handleSelect = (patient: Patient) => {
    onSelectPatient(patient);
    onOpenChange(false);
    setSearchQuery('');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Select Patient</DialogTitle>
        </DialogHeader>
        
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by name or MRN..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
            autoFocus
          />
        </div>

        <ScrollArea className="h-[300px] pr-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : filteredPatients.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              {searchQuery ? 'No patients found' : 'No patients available'}
            </div>
          ) : (
            <div className="space-y-1">
              {filteredPatients.map((patient) => (
                <Button
                  key={patient.id}
                  variant="ghost"
                  className="w-full justify-start h-auto py-3 px-3"
                  onClick={() => handleSelect(patient)}
                >
                  <User className="h-4 w-4 mr-3 text-muted-foreground flex-shrink-0" />
                  <div className="text-left">
                    <div className="font-medium">
                      {patient.last_name}, {patient.first_name}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      MRN: {patient.mrn} • {patient.gender}
                    </div>
                  </div>
                </Button>
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
