import { useState, useEffect, useRef } from 'react';
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
import { ArrowLeft, Mic, Square, FileText, Loader2, Play, Pause, Save, Upload, X, FileAudio } from 'lucide-react';

interface Patient {
  id: string;
  mrn: string;
  first_name: string;
  last_name: string;
}

export default function NewEncounter() {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [selectedPatientId, setSelectedPatientId] = useState<string>('');
  const [chiefComplaint, setChiefComplaint] = useState('');
  const [manualText, setManualText] = useState('');
  const [selectedNoteType, setSelectedNoteType] = useState<NoteType>('SOAP');
  const [isSaving, setIsSaving] = useState(false);
  const [encounterId, setEncounterId] = useState<string | null>(null);
  
  // Audio upload state
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [isTranscribingUpload, setIsTranscribingUpload] = useState(false);
  const [uploadTranscript, setUploadTranscript] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    // Validate file type
    const validTypes = ['audio/mp3', 'audio/mpeg', 'audio/wav', 'audio/webm', 'audio/ogg', 'audio/m4a', 'audio/x-m4a', 'audio/mp4'];
    if (!validTypes.includes(file.type) && !file.name.match(/\.(mp3|wav|webm|ogg|m4a)$/i)) {
      toast({ 
        title: 'Invalid file type', 
        description: 'Please upload an audio file (MP3, WAV, WebM, OGG, M4A)', 
        variant: 'destructive' 
      });
      return;
    }
    
    // Validate file size (max 25MB for Deepgram)
    if (file.size > 25 * 1024 * 1024) {
      toast({ 
        title: 'File too large', 
        description: 'Maximum file size is 25MB', 
        variant: 'destructive' 
      });
      return;
    }
    
    setUploadedFile(file);
    setUploadTranscript('');
  };

  const handleClearUpload = () => {
    setUploadedFile(null);
    setUploadTranscript('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleTranscribeUpload = async () => {
    if (!uploadedFile) return;
    
    setIsTranscribingUpload(true);
    try {
      // Read file as base64
      const arrayBuffer = await uploadedFile.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64 = btoa(binary);
      
      // Determine mime type
      let mimeType = uploadedFile.type || 'audio/mpeg';
      if (uploadedFile.name.endsWith('.mp3')) mimeType = 'audio/mpeg';
      else if (uploadedFile.name.endsWith('.wav')) mimeType = 'audio/wav';
      else if (uploadedFile.name.endsWith('.webm')) mimeType = 'audio/webm';
      else if (uploadedFile.name.endsWith('.m4a')) mimeType = 'audio/mp4';
      
      // Call deepgram-transcribe edge function
      const { data, error } = await supabase.functions.invoke('deepgram-transcribe', {
        body: {
          audioBase64: base64,
          mimeType,
        },
      });
      
      if (error) throw error;
      
      if (data?.transcript) {
        setUploadTranscript(data.transcript);
        // Also add to the main transcript
        addManualTranscript(data.transcript);
        toast({ 
          title: 'Transcription complete', 
          description: `${data.duration ? `${Math.round(data.duration)}s of audio processed` : 'Audio processed successfully'}` 
        });
      } else {
        toast({ 
          title: 'No speech detected', 
          description: 'The audio file may be empty or contain no speech', 
          variant: 'destructive' 
        });
      }
    } catch (err) {
      console.error('Upload transcription error:', err);
      toast({ 
        title: 'Transcription failed', 
        description: 'Please try again or use a different audio file', 
        variant: 'destructive' 
      });
    } finally {
      setIsTranscribingUpload(false);
    }
  };

  const handleGenerateNote = async () => {
    const fullTranscript = getFullTranscript();
    if (!fullTranscript && !manualText && !uploadTranscript) {
      toast({ title: 'No content', description: 'Please record, upload, or type some content first.', variant: 'destructive' });
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
        transcript: fullTranscript || uploadTranscript || manualText,
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
          <Button variant="ghost" size="icon" onClick={() => navigate('/encounters')}>
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

            {/* Audio File Upload */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Upload className="h-5 w-5" />
                  Upload Audio File
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="audio/*,.mp3,.wav,.webm,.ogg,.m4a"
                  onChange={handleFileSelect}
                  className="hidden"
                />
                
                {!uploadedFile ? (
                  <div 
                    onClick={() => fileInputRef.current?.click()}
                    className="border-2 border-dashed rounded-lg p-8 text-center cursor-pointer hover:border-primary hover:bg-muted/50 transition-colors"
                  >
                    <FileAudio className="h-10 w-10 mx-auto mb-3 text-muted-foreground" />
                    <p className="text-sm font-medium">Click to upload an audio file</p>
                    <p className="text-xs text-muted-foreground mt-1">MP3, WAV, WebM, OGG, M4A (max 25MB)</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between p-3 bg-muted rounded-lg">
                      <div className="flex items-center gap-3">
                        <FileAudio className="h-8 w-8 text-primary" />
                        <div>
                          <p className="text-sm font-medium truncate max-w-[200px]">{uploadedFile.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {(uploadedFile.size / 1024 / 1024).toFixed(2)} MB
                          </p>
                        </div>
                      </div>
                      <Button variant="ghost" size="sm" onClick={handleClearUpload}>
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                    
                    <Button 
                      onClick={handleTranscribeUpload} 
                      disabled={isTranscribingUpload}
                      className="w-full gap-2"
                    >
                      {isTranscribingUpload ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Transcribing...
                        </>
                      ) : (
                        <>
                          <FileText className="h-4 w-4" />
                          Transcribe Audio
                        </>
                      )}
                    </Button>
                    
                    {uploadTranscript && (
                      <div className="p-3 bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800 rounded-lg">
                        <p className="text-xs font-medium text-green-700 dark:text-green-300 mb-1">
                          Transcript from uploaded file:
                        </p>
                        <p className="text-sm text-green-900 dark:text-green-100 line-clamp-4">
                          {uploadTranscript}
                        </p>
                      </div>
                    )}
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