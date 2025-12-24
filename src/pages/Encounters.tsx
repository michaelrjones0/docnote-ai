import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
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
import { ArrowLeft, Mic, Square, FileText, Loader2, Play, Pause, Save } from 'lucide-react';

interface Patient {
  id: string;
  mrn: string;
  first_name: string;
  last_name: string;
}

export default function Encounters() {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [selectedPatientId, setSelectedPatientId] = useState<string>('');
  const [chiefComplaint, setChiefComplaint] = useState('');
  const [manualText, setManualText] = useState('');
  const [selectedNoteType, setSelectedNoteType] = useState<NoteType>('SOAP');
  const [isSaving, setIsSaving] = useState(false);
  const [encounterId, setEncounterId] = useState<string | null>(null);

  const { user, isLoading: authLoading, isProvider } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  
  const { isRecording, isPaused, audioBlob, startRecording, stopRecording, pauseRecording, resumeRecording, error: recorderError } = useAudioRecorder();
  const { transcript, isTranscribing, transcribeAudio, addManualTranscript, getFullTranscript, clearTranscript } = useTranscription();
  const { isGenerating, generatedNote, generateNote, setGeneratedNote } = useNoteGeneration();
  
  const { 
    previousVisits, 
    chronicConditions, 
    aiContextAnalysis, 
    isLoadingVisits, 
    isLoadingContext,
    fetchSmartContext,
    searchContextManually 
  } = usePreviousVisits(selectedPatientId || null);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/auth');
    }
  }, [user, authLoading, navigate]);

  useEffect(() => {
    if (user) {
      fetchPatients();
    }
  }, [user]);

  useEffect(() => {
    if (audioBlob && !isRecording) {
      transcribeAudio(audioBlob).catch(console.error);
    }
  }, [audioBlob, isRecording]);

  // Smart auto-context for chronic conditions
  useEffect(() => {
    if (chiefComplaint && chronicConditions.some(c => c.is_chronic)) {
      const timer = setTimeout(() => {
        fetchSmartContext(chiefComplaint);
      }, 1000); // Debounce
      return () => clearTimeout(timer);
    }
  }, [chiefComplaint, chronicConditions, fetchSmartContext]);

  const fetchPatients = async () => {
    const { data } = await supabase
      .from('patients')
      .select('id, mrn, first_name, last_name')
      .order('last_name');
    setPatients(data || []);
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
      toast({ title: 'No content', description: 'Please record or type some content first.', variant: 'destructive' });
      return;
    }

    try {
      // Include previous visit context for chronic conditions
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
    if (!generatedNote || !selectedPatientId || !user) {
      toast({ title: 'Cannot save', description: 'Generate a note first.', variant: 'destructive' });
      return;
    }

    setIsSaving(true);
    try {
      // Create encounter if not exists
      let currentEncounterId = encounterId;
      if (!currentEncounterId) {
        const { data: enc, error: encError } = await supabase
          .from('encounters')
          .insert({
            patient_id: selectedPatientId,
            provider_id: user.id,
            chief_complaint: chiefComplaint,
            status: 'completed',
          })
          .select('id')
          .single();

        if (encError) throw encError;
        currentEncounterId = enc.id;
        setEncounterId(enc.id);
      }

      // Save the note
      const { error: noteError } = await supabase
        .from('notes')
        .insert({
          encounter_id: currentEncounterId,
          note_type: selectedNoteType,
          raw_content: generatedNote,
          content: { text: generatedNote },
          created_by: user.id,
          is_finalized: true,
        });

      if (noteError) throw noteError;

      toast({ title: 'Note saved successfully' });
    } catch (err) {
      console.error('Save error:', err);
      toast({ title: 'Save failed', description: 'Please try again.', variant: 'destructive' });
    } finally {
      setIsSaving(false);
    }
  };

  const selectedPatient = patients.find(p => p.id === selectedPatientId);

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="container mx-auto px-4 py-4 flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/dashboard')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-xl font-semibold">New Encounter</h1>
          {isRecording && (
            <Badge variant="destructive" className="animate-pulse">
              <span className="h-2 w-2 rounded-full bg-destructive-foreground mr-2" />
              Recording
            </Badge>
          )}
          {selectedPatient && (
            <Badge variant="outline">
              {selectedPatient.last_name}, {selectedPatient.first_name}
            </Badge>
          )}
        </div>
      </header>

      <main className="container mx-auto px-4 py-6">
        <div className="grid lg:grid-cols-3 gap-6">
          {/* Left Panel - Recording & Transcript */}
          <div className="lg:col-span-2 space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Patient & Chief Complaint</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <Select value={selectedPatientId} onValueChange={setSelectedPatientId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select patient..." />
                  </SelectTrigger>
                  <SelectContent>
                    {patients.map(p => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.last_name}, {p.first_name} ({p.mrn})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Textarea
                  placeholder="Chief complaint..."
                  value={chiefComplaint}
                  onChange={(e) => setChiefComplaint(e.target.value)}
                  rows={2}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Ambient Listening</CardTitle>
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
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Transcript</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="min-h-[200px] max-h-[300px] overflow-y-auto border rounded-md p-4 bg-muted/30">
                  {transcript.length === 0 ? (
                    <p className="text-muted-foreground text-sm">Transcript will appear here...</p>
                  ) : (
                    transcript.map((seg) => (
                      <p key={seg.id} className="mb-2 text-sm">
                        {seg.content}
                      </p>
                    ))
                  )}
                </div>
                <div className="flex gap-2">
                  <Textarea
                    placeholder="Or type/paste text here..."
                    value={manualText}
                    onChange={(e) => setManualText(e.target.value)}
                    rows={2}
                    className="flex-1"
                  />
                  <Button onClick={handleAddManualText} variant="outline">Add</Button>
                </div>
              </CardContent>
            </Card>

            {/* Note Generation */}
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

            {generatedNote && (
              <Card>
                <CardHeader className="flex flex-row items-center justify-between">
                  <CardTitle>Generated Note</CardTitle>
                  <Button onClick={handleSaveNote} disabled={isSaving} size="sm" className="gap-2">
                    {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    Save Note
                  </Button>
                </CardHeader>
                <CardContent>
                  <Textarea
                    value={generatedNote}
                    onChange={(e) => setGeneratedNote(e.target.value)}
                    rows={20}
                    className="font-mono text-sm"
                  />
                </CardContent>
              </Card>
            )}
          </div>

          {/* Right Panel - Previous Visits & Context */}
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