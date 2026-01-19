import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useAudioRecorder } from '@/hooks/useAudioRecorder';
import { useTranscription } from '@/hooks/useTranscription';
import { useNoteGeneration, NoteType } from '@/hooks/useNoteGeneration';
import { usePreviousVisits } from '@/hooks/usePreviousVisits';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { PreviousVisitsPanel } from '@/components/encounters/PreviousVisitsPanel';
import { useToast } from '@/hooks/use-toast';
import { 
  ArrowLeft, Mic, Square, FileText, Loader2, Play, Pause, Save, 
  CheckCircle2, Clock, Edit2, X 
} from 'lucide-react';
import { format } from 'date-fns';

interface EncounterData {
  id: string;
  encounter_date: string;
  chief_complaint: string | null;
  status: 'in_progress' | 'completed' | 'cancelled';
  patient_id: string;
  patient: {
    id: string;
    first_name: string;
    last_name: string;
    mrn: string;
  };
  notes: {
    id: string;
    note_type: string;
    raw_content: string | null;
    content: any;
    is_finalized: boolean;
    created_at: string;
  }[];
}

export default function EncounterDetail() {
  const { encounterId } = useParams<{ encounterId: string }>();
  const [encounter, setEncounter] = useState<EncounterData | null>(null);
  const [isLoadingEncounter, setIsLoadingEncounter] = useState(true);
  const [chiefComplaint, setChiefComplaint] = useState('');
  const [manualText, setManualText] = useState('');
  const [selectedNoteType, setSelectedNoteType] = useState<NoteType>('SOAP');
  const [isSaving, setIsSaving] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editedNote, setEditedNote] = useState('');
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);

  const { user, isLoading: authLoading } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  
  const { 
    isRecording, isPaused, audioBlob, 
    startRecording, stopRecording, pauseRecording, resumeRecording, 
    error: recorderError 
  } = useAudioRecorder();
  
  const { 
    transcript, isTranscribing, 
    transcribeAudio, addManualTranscript, getFullTranscript, clearTranscript 
  } = useTranscription();
  
  const { isGenerating, generatedNote, generateNote, setGeneratedNote } = useNoteGeneration();
  
  const { 
    previousVisits, chronicConditions, aiContextAnalysis, 
    isLoadingVisits, isLoadingContext, searchContextManually 
  } = usePreviousVisits(encounter?.patient_id || null);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/auth');
    }
  }, [user, authLoading, navigate]);

  useEffect(() => {
    if (user && encounterId) {
      fetchEncounter();
    }
  }, [user, encounterId]);

  useEffect(() => {
    if (audioBlob && !isRecording) {
      transcribeAudio(audioBlob).catch(console.error);
    }
  }, [audioBlob, isRecording]);

  const fetchEncounter = async () => {
    if (!encounterId) return;
    
    setIsLoadingEncounter(true);
    try {
      const { data, error } = await supabase
        .from('encounters')
        .select(`
          id,
          encounter_date,
          chief_complaint,
          status,
          patient_id,
          patient:patients!inner (
            id,
            first_name,
            last_name,
            mrn
          ),
          notes (
            id,
            note_type,
            raw_content,
            content,
            is_finalized,
            created_at
          )
        `)
        .eq('id', encounterId)
        .maybeSingle();

      if (error) throw error;
      if (!data) {
        toast({ title: 'Encounter not found', variant: 'destructive' });
        navigate('/encounters');
        return;
      }

      const transformedData = {
        ...data,
        patient: Array.isArray(data.patient) ? data.patient[0] : data.patient,
        notes: (data.notes || []).sort((a: any, b: any) => 
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        )
      } as EncounterData;

      setEncounter(transformedData);
      setChiefComplaint(transformedData.chief_complaint || '');
      
      // Set the most recent note for editing
      if (transformedData.notes.length > 0) {
        const latestNote = transformedData.notes[0];
        setEditedNote(latestNote.raw_content || '');
        setActiveNoteId(latestNote.id);
        setSelectedNoteType(latestNote.note_type as NoteType);
      }
    } catch (err) {
      console.error('Error fetching encounter:', err);
      toast({ title: 'Error loading encounter', variant: 'destructive' });
    } finally {
      setIsLoadingEncounter(false);
    }
  };

  const handleAddManualText = () => {
    if (manualText.trim()) {
      addManualTranscript(manualText.trim());
      setManualText('');
    }
  };

  const handleGenerateNote = async () => {
    const fullTranscript = getFullTranscript();
    if (!fullTranscript && !manualText) {
      toast({ 
        title: 'No content', 
        description: 'Please record or type some content first.', 
        variant: 'destructive' 
      });
      return;
    }

    try {
      const previousVisitData = previousVisits.slice(0, 5).map(v => ({
        date: v.date,
        chiefComplaint: v.chiefComplaint,
        summary: v.summary,
      }));

      const chronicData = chronicConditions.filter(c => c.is_chronic);

      await generateNote({
        noteType: selectedNoteType,
        transcript: fullTranscript || manualText,
        chiefComplaint,
        previousVisits: previousVisitData,
        chronicConditions: chronicData,
      });
      toast({ title: 'Note generated successfully' });
    } catch (err) {
      toast({ title: 'Generation failed', description: 'Please try again.', variant: 'destructive' });
    }
  };

  const handleSaveNote = async () => {
    const noteContent = generatedNote || editedNote;
    if (!noteContent || !encounter || !user) {
      toast({ title: 'Cannot save', description: 'No note content.', variant: 'destructive' });
      return;
    }

    setIsSaving(true);
    try {
      if (activeNoteId) {
        // Update existing note
        const { error } = await supabase
          .from('notes')
          .update({
            raw_content: noteContent,
            content: { text: noteContent },
            note_type: selectedNoteType,
          })
          .eq('id', activeNoteId);

        if (error) throw error;
      } else {
        // Create new note
        const { error } = await supabase
          .from('notes')
          .insert({
            encounter_id: encounter.id,
            note_type: selectedNoteType,
            raw_content: noteContent,
            content: { text: noteContent },
            created_by: user.id,
            is_finalized: true,
          });

        if (error) throw error;
      }

      toast({ title: 'Note saved successfully' });
      setIsEditing(false);
      fetchEncounter(); // Refresh data
    } catch (err) {
      console.error('Save error:', err);
      toast({ title: 'Save failed', description: 'Please try again.', variant: 'destructive' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleCompleteEncounter = async () => {
    if (!encounter) return;
    
    setIsSaving(true);
    try {
      const { error } = await supabase
        .from('encounters')
        .update({ status: 'completed' })
        .eq('id', encounter.id);

      if (error) throw error;
      
      toast({ title: 'Encounter completed' });
      fetchEncounter();
    } catch (err) {
      toast({ title: 'Error completing encounter', variant: 'destructive' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleResumeEncounter = async () => {
    if (!encounter) return;
    
    try {
      const { error } = await supabase
        .from('encounters')
        .update({ status: 'in_progress' })
        .eq('id', encounter.id);

      if (error) throw error;
      
      toast({ title: 'Encounter resumed' });
      fetchEncounter();
    } catch (err) {
      toast({ title: 'Error resuming encounter', variant: 'destructive' });
    }
  };

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
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  if (authLoading || isLoadingEncounter) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!encounter) {
    return null;
  }

  const isInProgress = encounter.status === 'in_progress';
  const latestNote = encounter.notes[0];
  const noteContent = generatedNote || editedNote || latestNote?.raw_content || '';

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => navigate('/encounters')}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div>
              <h1 className="text-xl font-semibold">
                {encounter.patient.last_name}, {encounter.patient.first_name}
              </h1>
              <p className="text-sm text-muted-foreground">
                {format(new Date(encounter.encounter_date), 'MMMM d, yyyy • h:mm a')}
              </p>
            </div>
            {getStatusBadge(encounter.status)}
            {isRecording && (
              <Badge variant="destructive" className="animate-pulse">
                <span className="h-2 w-2 rounded-full bg-destructive-foreground mr-2" />
                Recording
              </Badge>
            )}
          </div>
          <div className="flex gap-2">
            {isInProgress ? (
              <Button onClick={handleCompleteEncounter} disabled={isSaving} className="gap-2">
                <CheckCircle2 className="h-4 w-4" /> Complete Encounter
              </Button>
            ) : (
              <Button onClick={handleResumeEncounter} variant="outline" className="gap-2">
                <Play className="h-4 w-4" /> Resume Encounter
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6">
        <div className="grid lg:grid-cols-3 gap-6">
          {/* Left Panel */}
          <div className="lg:col-span-2 space-y-6">
            {/* Patient & Encounter Info */}
            <Card>
              <CardHeader>
                <CardTitle>Encounter Details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">Patient</p>
                    <p className="font-medium">{encounter.patient.last_name}, {encounter.patient.first_name}</p>
                    <p className="text-sm text-muted-foreground">{encounter.patient.mrn}</p>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">Chief Complaint</p>
                    {isInProgress ? (
                      <Textarea
                        value={chiefComplaint}
                        onChange={(e) => setChiefComplaint(e.target.value)}
                        rows={2}
                        placeholder="Enter chief complaint..."
                      />
                    ) : (
                      <p>{chiefComplaint || <span className="italic text-muted-foreground">Not specified</span>}</p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Recording Section - Only for in_progress */}
            {isInProgress && (
              <>
                <Card>
                  <CardHeader>
                    <CardTitle>Continue Recording</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="flex gap-2">
                      {!isRecording ? (
                        <Button onClick={startRecording} className="gap-2">
                          <Mic className="h-4 w-4" /> Start Recording
                        </Button>
                      ) : (
                        <>
                          <Button onClick={isPaused ? resumeRecording : pauseRecording} variant="outline" className="gap-2">
                            {isPaused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
                            {isPaused ? 'Resume' : 'Pause'}
                          </Button>
                          <Button onClick={stopRecording} variant="destructive" className="gap-2">
                            <Square className="h-4 w-4" /> Stop
                          </Button>
                        </>
                      )}
                    </div>
                    {recorderError && <p className="text-sm text-destructive">{recorderError}</p>}
                    {isTranscribing && (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" /> Transcribing...
                      </div>
                    )}
                    
                    {transcript.length > 0 && (
                      <div className="min-h-[100px] max-h-[200px] overflow-y-auto border rounded-md p-4 bg-muted/30">
                        {transcript.map((seg) => (
                          <p key={seg.id} className="mb-2 text-sm">{seg.content}</p>
                        ))}
                      </div>
                    )}
                    
                    <div className="flex gap-2">
                      <Textarea
                        placeholder="Or type/paste additional text..."
                        value={manualText}
                        onChange={(e) => setManualText(e.target.value)}
                        rows={2}
                        className="flex-1"
                      />
                      <Button onClick={handleAddManualText} variant="outline">Add</Button>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Generate Note</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="flex gap-2">
                      <Select value={selectedNoteType} onValueChange={(v) => setSelectedNoteType(v as NoteType)}>
                        <SelectTrigger className="w-48">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="SOAP">SOAP Note</SelectItem>
                          <SelectItem value="H&P">History & Physical</SelectItem>
                          <SelectItem value="Progress">Progress Note</SelectItem>
                          <SelectItem value="Procedure">Procedure Note</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button onClick={handleGenerateNote} disabled={isGenerating} className="gap-2">
                        {isGenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
                        Generate
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </>
            )}

            {/* Note Display/Edit */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <FileText className="h-5 w-5" />
                  {latestNote ? `${latestNote.note_type} Note` : 'Clinical Note'}
                </CardTitle>
                <div className="flex gap-2">
                  {!isEditing && noteContent && (
                    <Button 
                      variant="outline" 
                      size="sm" 
                      className="gap-1"
                      onClick={() => setIsEditing(true)}
                    >
                      <Edit2 className="h-3 w-3" /> Edit
                    </Button>
                  )}
                  {(isEditing || generatedNote) && (
                    <>
                      {isEditing && (
                        <Button 
                          variant="ghost" 
                          size="sm" 
                          onClick={() => {
                            setIsEditing(false);
                            setEditedNote(latestNote?.raw_content || '');
                          }}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      )}
                      <Button 
                        onClick={handleSaveNote} 
                        disabled={isSaving} 
                        size="sm" 
                        className="gap-2"
                      >
                        {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                        Save
                      </Button>
                    </>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {!noteContent ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <FileText className="h-12 w-12 mx-auto mb-4 opacity-50" />
                    <p>No note generated yet</p>
                    {isInProgress && (
                      <p className="text-sm">Record or type content, then generate a note</p>
                    )}
                  </div>
                ) : isEditing || generatedNote ? (
                  <Textarea
                    value={generatedNote || editedNote}
                    onChange={(e) => generatedNote ? setGeneratedNote(e.target.value) : setEditedNote(e.target.value)}
                    rows={20}
                    className="font-mono text-sm"
                  />
                ) : (
                  <div className="prose prose-sm max-w-none dark:prose-invert whitespace-pre-wrap font-mono text-sm bg-muted/30 rounded-md p-4 max-h-[500px] overflow-y-auto">
                    {noteContent}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Previous Notes */}
            {encounter.notes.length > 1 && (
              <Card>
                <CardHeader>
                  <CardTitle>Previous Notes ({encounter.notes.length - 1})</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {encounter.notes.slice(1).map((note) => (
                    <div key={note.id} className="border rounded-md p-4">
                      <div className="flex items-center justify-between mb-2">
                        <Badge variant="outline">{note.note_type}</Badge>
                        <span className="text-sm text-muted-foreground">
                          {format(new Date(note.created_at), 'MMM d, yyyy h:mm a')}
                        </span>
                      </div>
                      <p className="text-sm text-muted-foreground line-clamp-3">
                        {note.raw_content?.substring(0, 200)}...
                      </p>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}
          </div>

          {/* Right Panel - Previous Visits */}
          <div className="space-y-4">
            <PreviousVisitsPanel
              previousVisits={previousVisits}
              chronicConditions={chronicConditions}
              aiContextAnalysis={aiContextAnalysis}
              isLoadingVisits={isLoadingVisits}
              isLoadingContext={isLoadingContext}
              onSearchContext={() => searchContextManually(chiefComplaint)}
              chiefComplaint={chiefComplaint}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
