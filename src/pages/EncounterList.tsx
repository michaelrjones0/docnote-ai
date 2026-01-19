import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useToast } from '@/hooks/use-toast';
import { 
  ArrowLeft, Plus, Search, Loader2, FileText, Play, Eye, Clock, 
  CheckCircle2, MoreHorizontal, XCircle, Trash2, Radio 
} from 'lucide-react';
import { format } from 'date-fns';

interface EncounterWithPatient {
  id: string;
  encounter_date: string;
  chief_complaint: string | null;
  status: 'in_progress' | 'completed' | 'cancelled';
  patient: {
    id: string;
    first_name: string;
    last_name: string;
    mrn: string;
  };
  notes: {
    id: string;
    note_type: string;
  }[];
}

type StatusFilter = 'all' | 'in_progress' | 'completed' | 'cancelled';
type DialogAction = 'cancel' | 'delete' | null;

export default function EncounterList() {
  const [encounters, setEncounters] = useState<EncounterWithPatient[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [selectedEncounter, setSelectedEncounter] = useState<EncounterWithPatient | null>(null);
  const [dialogAction, setDialogAction] = useState<DialogAction>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  
  const { user, isLoading: authLoading } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/auth');
    }
  }, [user, authLoading, navigate]);

  useEffect(() => {
    if (user) {
      fetchEncounters();
    }
  }, [user]);

  const fetchEncounters = async () => {
    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from('encounters')
        .select(`
          id,
          encounter_date,
          chief_complaint,
          status,
          patient:patients!inner (
            id,
            first_name,
            last_name,
            mrn
          ),
          notes (
            id,
            note_type
          )
        `)
        .order('encounter_date', { ascending: false });

      if (error) throw error;
      
      const transformedData = (data || []).map(enc => ({
        ...enc,
        patient: Array.isArray(enc.patient) ? enc.patient[0] : enc.patient,
        notes: enc.notes || []
      })) as EncounterWithPatient[];
      
      setEncounters(transformedData);
    } catch (err) {
      console.error('Error fetching encounters:', err);
      toast({ 
        title: 'Error loading encounters', 
        description: 'Please try again.', 
        variant: 'destructive' 
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancelEncounter = async () => {
    if (!selectedEncounter) return;
    
    setIsProcessing(true);
    try {
      const { error } = await supabase
        .from('encounters')
        .update({ status: 'cancelled' })
        .eq('id', selectedEncounter.id);

      if (error) throw error;
      
      toast({ title: 'Encounter cancelled' });
      fetchEncounters();
    } catch (err) {
      console.error('Error cancelling encounter:', err);
      toast({ 
        title: 'Failed to cancel encounter', 
        description: 'Please try again.', 
        variant: 'destructive' 
      });
    } finally {
      setIsProcessing(false);
      setDialogAction(null);
      setSelectedEncounter(null);
    }
  };

  const handleDeleteEncounter = async () => {
    if (!selectedEncounter) return;
    
    setIsProcessing(true);
    try {
      const { error } = await supabase
        .from('encounters')
        .delete()
        .eq('id', selectedEncounter.id);

      if (error) throw error;
      
      toast({ title: 'Encounter deleted' });
      fetchEncounters();
    } catch (err) {
      console.error('Error deleting encounter:', err);
      toast({ 
        title: 'Failed to delete encounter', 
        description: 'Please try again.', 
        variant: 'destructive' 
      });
    } finally {
      setIsProcessing(false);
      setDialogAction(null);
      setSelectedEncounter(null);
    }
  };

  const openDialog = (encounter: EncounterWithPatient, action: DialogAction) => {
    setSelectedEncounter(encounter);
    setDialogAction(action);
  };

  const closeDialog = () => {
    setDialogAction(null);
    setSelectedEncounter(null);
  };

  const filteredEncounters = encounters.filter(enc => {
    if (statusFilter !== 'all' && enc.status !== statusFilter) {
      return false;
    }
    
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      const patientName = `${enc.patient.first_name} ${enc.patient.last_name}`.toLowerCase();
      const mrn = enc.patient.mrn.toLowerCase();
      const complaint = (enc.chief_complaint || '').toLowerCase();
      
      return patientName.includes(query) || mrn.includes(query) || complaint.includes(query);
    }
    
    return true;
  });

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'in_progress':
        return (
          <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 gap-1">
            <Clock className="h-3 w-3" /> In Progress
          </Badge>
        );
      case 'completed':
        return (
          <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200 gap-1">
            <CheckCircle2 className="h-3 w-3" /> Completed
          </Badge>
        );
      case 'cancelled':
        return (
          <Badge variant="outline" className="bg-muted text-muted-foreground gap-1">
            <XCircle className="h-3 w-3" /> Cancelled
          </Badge>
        );
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const handleRowClick = (encounterId: string) => {
    navigate(`/encounters/${encounterId}`);
  };

  if (authLoading || isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => navigate('/dashboard')}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <h1 className="text-xl font-semibold">Encounters</h1>
            <Badge variant="secondary">{filteredEncounters.length} total</Badge>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => navigate('/app')} className="gap-2">
              <Radio className="h-4 w-4" /> Live Scribe
            </Button>
            <Button onClick={() => navigate('/encounters/new')} className="gap-2">
              <Plus className="h-4 w-4" /> New Encounter
            </Button>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 space-y-6">
        {/* Filters */}
        <Card>
          <CardContent className="pt-6">
            <div className="flex flex-col sm:flex-row gap-4">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search by patient name, MRN, or chief complaint..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>
              <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
                <SelectTrigger className="w-full sm:w-48">
                  <SelectValue placeholder="Filter by status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="in_progress">In Progress</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="cancelled">Cancelled</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        {/* Encounter Table */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Patient Encounters
            </CardTitle>
          </CardHeader>
          <CardContent>
            {filteredEncounters.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <FileText className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p className="text-lg font-medium">No encounters found</p>
                <p className="text-sm">
                  {searchQuery || statusFilter !== 'all' 
                    ? 'Try adjusting your filters' 
                    : 'Start a new encounter to get started'}
                </p>
                {!searchQuery && statusFilter === 'all' && (
                  <Button className="mt-4" onClick={() => navigate('/encounters/new')}>
                    <Plus className="h-4 w-4 mr-2" /> New Encounter
                  </Button>
                )}
              </div>
            ) : (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Patient</TableHead>
                      <TableHead>MRN</TableHead>
                      <TableHead>Chief Complaint</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Notes</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredEncounters.map((enc) => (
                      <TableRow 
                        key={enc.id} 
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() => handleRowClick(enc.id)}
                      >
                        <TableCell className="font-medium">
                          {format(new Date(enc.encounter_date), 'MMM d, yyyy')}
                          <div className="text-xs text-muted-foreground">
                            {format(new Date(enc.encounter_date), 'h:mm a')}
                          </div>
                        </TableCell>
                        <TableCell>
                          {enc.patient.last_name}, {enc.patient.first_name}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {enc.patient.mrn}
                        </TableCell>
                        <TableCell className="max-w-[200px] truncate">
                          {enc.chief_complaint || <span className="text-muted-foreground italic">Not specified</span>}
                        </TableCell>
                        <TableCell>
                          {getStatusBadge(enc.status)}
                        </TableCell>
                        <TableCell>
                          {enc.notes.length > 0 ? (
                            <Badge variant="secondary" className="gap-1">
                              <FileText className="h-3 w-3" /> {enc.notes.length}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground text-sm">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2" onClick={(e) => e.stopPropagation()}>
                            {enc.status === 'in_progress' ? (
                              <Button 
                                size="sm" 
                                variant="outline" 
                                className="gap-1"
                                onClick={() => navigate(`/encounters/${enc.id}`)}
                              >
                                <Play className="h-3 w-3" /> Resume
                              </Button>
                            ) : (
                              <Button 
                                size="sm" 
                                variant="ghost" 
                                className="gap-1"
                                onClick={() => navigate(`/encounters/${enc.id}`)}
                              >
                                <Eye className="h-3 w-3" /> View
                              </Button>
                            )}
                            
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                                  <MoreHorizontal className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={() => navigate(`/encounters/${enc.id}`)}>
                                  <Eye className="h-4 w-4 mr-2" /> View Details
                                </DropdownMenuItem>
                                {enc.status !== 'cancelled' && (
                                  <DropdownMenuItem 
                                    onClick={() => openDialog(enc, 'cancel')}
                                    className="text-amber-600"
                                  >
                                    <XCircle className="h-4 w-4 mr-2" /> Cancel Encounter
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuSeparator />
                                <DropdownMenuItem 
                                  onClick={() => openDialog(enc, 'delete')}
                                  className="text-destructive"
                                >
                                  <Trash2 className="h-4 w-4 mr-2" /> Delete Encounter
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </main>

      {/* Cancel Confirmation Dialog */}
      <AlertDialog open={dialogAction === 'cancel'} onOpenChange={(open) => !open && closeDialog()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel Encounter?</AlertDialogTitle>
            <AlertDialogDescription>
              This will mark the encounter for{' '}
              <span className="font-medium text-foreground">
                {selectedEncounter?.patient.last_name}, {selectedEncounter?.patient.first_name}
              </span>{' '}
              as cancelled. The encounter and any associated notes will be preserved but marked as inactive.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isProcessing}>Keep Encounter</AlertDialogCancel>
            <AlertDialogAction 
              onClick={handleCancelEncounter}
              disabled={isProcessing}
              className="bg-amber-600 hover:bg-amber-700"
            >
              {isProcessing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Cancel Encounter
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={dialogAction === 'delete'} onOpenChange={(open) => !open && closeDialog()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Encounter?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the encounter for{' '}
              <span className="font-medium text-foreground">
                {selectedEncounter?.patient.last_name}, {selectedEncounter?.patient.first_name}
              </span>
              {selectedEncounter?.notes && selectedEncounter.notes.length > 0 && (
                <span className="block mt-2 text-destructive">
                  Warning: This encounter has {selectedEncounter.notes.length} associated note(s) that may also be affected.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isProcessing}>Keep Encounter</AlertDialogCancel>
            <AlertDialogAction 
              onClick={handleDeleteEncounter}
              disabled={isProcessing}
              className="bg-destructive hover:bg-destructive/90"
            >
              {isProcessing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Delete Permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
