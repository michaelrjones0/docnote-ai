import { useEffect, useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AutoResizeTextarea } from '@/components/ui/auto-resize-textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Loader2, LogOut, ShieldCheck, Play, FileText, Copy, Check, RefreshCw, Trash2, AlertTriangle, Settings, Mic, Square, Radio, Pause } from 'lucide-react';
import { useDocNoteSession, isNote4Field, isNote3Field } from '@/hooks/useDocNoteSession';
import { usePhysicianPreferences, NoteEditorMode, PhysicianPreferences } from '@/hooks/usePhysicianPreferences';
import { useLiveScribe } from '@/hooks/useLiveScribe';
import { DemoModeGuard, DemoModeBanner, ResetDemoAckButton } from '@/components/DemoModeGuard';

// Format recording time as mm:ss or hh:mm:ss if over 1 hour
function formatRecordingTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  
  if (hours > 0) {
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

interface SoapData {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
}

interface Soap3Data {
  subjective: string;
  objective: string;
  assessmentPlan: string;
}

interface ApEntry {
  problem: string;
  assessment: string;
  plan: string[];
}

interface SoapResponse {
  noteType: string;
  note: string;
  markdown: string;
  soap?: SoapData;
  soap3?: Soap3Data;
  ap?: ApEntry[];
  error?: string;
}

const AppHome = () => {
  const { user, session, isLoading, signOut } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [authCheckResult, setAuthCheckResult] = useState<string | null>(null);
  const [isTestingAuth, setIsTestingAuth] = useState(false);
  const [batchStatusResult, setBatchStatusResult] = useState<string | null>(null);
  const [isTestingBatchStatus, setIsTestingBatchStatus] = useState(false);
  const [startBatchResult, setStartBatchResult] = useState<string | null>(null);
  const [isStartingBatch, setIsStartingBatch] = useState(false);
  const [isGeneratingSoap, setIsGeneratingSoap] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const { preferences, setPreferences } = usePhysicianPreferences();
  
  // Keep a ref to preferences for use in callbacks (fixes stale closure)
  const preferencesRef = useRef<PhysicianPreferences>(preferences);
  useEffect(() => {
    preferencesRef.current = preferences;
  }, [preferences]);

  const {
    session: docSession,
    showConflictBanner,
    modeMismatchWarning,
    setJobName,
    setTranscriptText,
    setMarkdownExpanded,
    setLiveDraftMode,
    setRunningSummary,
    handleNewGenerated,
    acceptNewGenerated,
    keepUserEdits,
    clearModeMismatchWarning,
    // 4-field helpers
    editSoapField,
    syncMarkdownFromSoap,
    getCurrentSoap,
    // 3-field helpers
    editSoap3Field,
    syncMarkdownFromSoap3,
    getCurrentSoap3,
    getCurrentAp,
    // Common helpers
    clearSession,
    getCurrentMarkdown,
    getExportJson,
    getCurrentNoteType,
    getPatientInstructions,
    editPatientInstructions,
  } = useDocNoteSession();

  // Live Scribe
  const liveTranscriptRef = useRef<HTMLPreElement>(null);
  const conflictBannerRef = useRef<HTMLDivElement>(null);
  const modeSwitchBannerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to conflict banner when it appears
  useEffect(() => {
    if (showConflictBanner && conflictBannerRef.current) {
      conflictBannerRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [showConflictBanner]);

  // Auto-scroll to mode switch banner when conditions change
  useEffect(() => {
    const noteType = getCurrentNoteType();
    const soap = getCurrentSoap();
    const soap3 = getCurrentSoap3();
    const hasNoteNow = soap !== null || soap3 !== null;
    const shouldShow = hasNoteNow && noteType !== preferences.noteEditorMode;
    
    if (shouldShow && modeSwitchBannerRef.current) {
      modeSwitchBannerRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [preferences.noteEditorMode, getCurrentNoteType, getCurrentSoap, getCurrentSoap3]);
  const liveScribe = useLiveScribe({
    onTranscriptUpdate: (transcript) => {
      setTranscriptText(transcript);
      // Auto-scroll live transcript
      setTimeout(() => {
        if (liveTranscriptRef.current) {
          liveTranscriptRef.current.scrollTop = liveTranscriptRef.current.scrollHeight;
        }
      }, 50);
    },
    onSummaryUpdate: (summary) => {
      setRunningSummary(summary);
    },
    onError: (err) => {
      toast({
        title: 'Live Scribe Error',
        description: err,
        variant: 'destructive',
      });
    },
    chunkIntervalMs: 10000, // Send chunks every 10 seconds
    liveDraftMode: docSession.liveDraftMode,
    preferences,
  });

  const handleStartLiveScribe = async () => {
    await liveScribe.startRecording();
  };

  const handleStopLiveScribe = async () => {
    const finalTranscript = await liveScribe.stopRecording();
    
    // Auto-generate note if we have a transcript
    if (finalTranscript?.trim()) {
      setTranscriptText(finalTranscript);
      // Small delay to ensure state is updated
      setTimeout(() => {
        handleGenerateSoap();
      }, 100);
    }
  };

  useEffect(() => {
    if (!isLoading && !user) {
      navigate('/login');
    }
  }, [user, isLoading, navigate]);

  const handleLogout = async () => {
    const { error } = await signOut();
    if (error) {
      toast({
        title: 'Logout failed',
        description: error.message,
        variant: 'destructive',
      });
    } else {
      toast({
        title: 'Logged out',
        description: 'You have been successfully logged out.',
      });
      navigate('/');
    }
  };

  const handleTestAuth = async () => {
    if (!session?.access_token) {
      setAuthCheckResult(JSON.stringify({ ok: false, error: 'No access token available' }, null, 2));
      return;
    }

    setIsTestingAuth(true);
    setAuthCheckResult(null);

    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/auth-check`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const data = await response.json();
      setAuthCheckResult(JSON.stringify(data, null, 2));
    } catch (err) {
      setAuthCheckResult(JSON.stringify({ ok: false, error: String(err) }, null, 2));
    } finally {
      setIsTestingAuth(false);
    }
  };

  const handleTestBatchStatus = async (overrideJobName?: string) => {
    const jobNameToUse = overrideJobName ?? docSession.jobName ?? '';
    if (!session?.access_token) {
      setBatchStatusResult(JSON.stringify({ ok: false, error: 'No access token available' }, null, 2));
      return;
    }

    setIsTestingBatchStatus(true);
    setBatchStatusResult(null);

    try {
      const response = await fetch(
        'https://jmzmwkfctefzokhesxjf.supabase.co/functions/v1/transcribe-audio-batch-status',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ jobName: jobNameToUse }),
        }
      );

      const data = await response.json();
      setBatchStatusResult(JSON.stringify(data, null, 2));
      
      // Extract and persist transcript text
      const text = (data?.text ?? data?.result?.text) ?? '';
      if (typeof text === 'string' && text.trim()) {
        setTranscriptText(text.trim());
      }
    } catch (err) {
      setBatchStatusResult(JSON.stringify({ ok: false, error: String(err) }, null, 2));
    } finally {
      setIsTestingBatchStatus(false);
    }
  };

  const handleStartBatchLatest = async () => {
    if (!session?.access_token) {
      setStartBatchResult(JSON.stringify({ ok: false, error: 'No access token available' }, null, 2));
      return;
    }

    setIsStartingBatch(true);
    setStartBatchResult(null);

    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/start-batch-latest`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const data = await response.json();
      setStartBatchResult(JSON.stringify(data, null, 2));
      
      // On success, auto-fill jobName and trigger batch status check
      if (data.ok && data.jobName) {
        setJobName(data.jobName);
        // Wait a moment then trigger the batch status check
        setTimeout(() => {
          handleTestBatchStatus(data.jobName);
        }, 500);
      }
    } catch (err) {
      setStartBatchResult(JSON.stringify({ ok: false, error: String(err) }, null, 2));
    } finally {
      setIsStartingBatch(false);
    }
  };

  const handleGenerateSoap = useCallback(async () => {
    const transcript = docSession.transcriptText;
    if (!transcript) {
      toast({
        title: 'No transcript available',
        description: 'Please run "Test Batch Status" first to get a completed transcript.',
        variant: 'destructive',
      });
      return;
    }

    setIsGeneratingSoap(true);
    // Always use the latest preferences from ref to avoid stale closure
    const currentPrefs = preferencesRef.current;
    const expectedMode = currentPrefs.noteEditorMode;

    try {
      const { data, error } = await supabase.functions.invoke('generate-note', {
        body: { 
          noteType: 'SOAP',
          transcript,
          preferences: currentPrefs
        }
      });

      if (error) {
        toast({
          title: 'Generation failed',
          description: error.message,
          variant: 'destructive',
        });
        return;
      }
      
      // Handle 4-field response
      if (data?.soap && (data.noteType === 'SOAP_4_FIELD' || data.noteType === 'SOAP' || expectedMode === 'SOAP_4_FIELD')) {
        handleNewGenerated({
          noteType: 'SOAP_4_FIELD',
          soap: data.soap,
          markdown: data.markdown || data.note || '',
          patientInstructions: data.patientInstructions || '',
        }, expectedMode);
        toast({
          title: 'SOAP note generated',
          description: 'Your 4-field SOAP note has been generated.',
        });
        return;
      }
      
      // Handle 3-field response
      if (data?.soap3 && (data.noteType === 'SOAP_3_FIELD' || expectedMode === 'SOAP_3_FIELD')) {
        handleNewGenerated({
          noteType: 'SOAP_3_FIELD',
          soap3: data.soap3,
          ap: data.ap || [],
          markdown: data.markdown || data.note || '',
          patientInstructions: data.patientInstructions || '',
        }, expectedMode);
        toast({
          title: 'SOAP note generated',
          description: 'Your 3-field SOAP note has been generated.',
        });
        return;
      }

      // Fallback: unexpected response structure
      toast({
        title: 'Generation issue',
        description: 'Unexpected response format from AI. Check console for details.',
        variant: 'destructive',
      });
      console.error('[AppHome] Unexpected generate-note response:', data);
    } catch (err) {
      toast({
        title: 'Generation failed',
        description: String(err),
        variant: 'destructive',
      });
    } finally {
      setIsGeneratingSoap(false);
    }
  }, [docSession.transcriptText, handleNewGenerated, toast]);

  const copyToClipboard = async (text: string, fieldName: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(fieldName);
      toast({
        title: 'Copied!',
        description: `${fieldName} copied to clipboard.`,
      });
      setTimeout(() => setCopiedField(null), 2000);
    } catch {
      toast({
        title: 'Copy failed',
        description: 'Could not copy to clipboard.',
        variant: 'destructive',
      });
    }
  };

const CopyButton = ({ text, label }: { text: string; label: string }) => (
    <Button
      variant="outline"
      size="sm"
      onClick={() => copyToClipboard(text, label)}
      className="flex items-center gap-1"
      disabled={!text}
    >
      {copiedField === label ? (
        <Check className="h-3 w-3" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
      {label}
    </Button>
  );

  // Per-section copy button with inline feedback
  const SectionCopyButton = ({ text, sectionName }: { text: string; sectionName: string }) => {
    const [copied, setCopied] = useState(false);
    const [disabled, setDisabled] = useState(false);

    const handleCopy = async () => {
      if (disabled) return;
      
      if (!text || !text.trim()) {
        toast({
          title: 'Nothing to copy',
          description: `${sectionName} section is empty.`,
          variant: 'default',
        });
        return;
      }

      setDisabled(true);
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => {
          setCopied(false);
          setDisabled(false);
        }, 1500);
      } catch {
        toast({
          title: 'Copy failed',
          description: 'Could not copy to clipboard.',
          variant: 'destructive',
        });
        setDisabled(false);
      }
    };

    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={handleCopy}
        disabled={disabled}
        className="h-6 px-2 text-xs flex items-center gap-1"
      >
        {copied ? (
          <>
            <Check className="h-3 w-3" />
            Copied
          </>
        ) : (
          <>
            <Copy className="h-3 w-3" />
            Copy
          </>
        )}
      </Button>
    );
  };

  const handleClearSession = () => {
    clearSession();
    setBatchStatusResult(null);
    setStartBatchResult(null);
    setAuthCheckResult(null);
    toast({
      title: 'Session cleared',
      description: 'All data has been cleared.',
    });
  };

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!user) {
    return null;
  }

  const currentSoap = getCurrentSoap();
  const currentSoap3 = getCurrentSoap3();
  const currentAp = getCurrentAp();
  const currentMarkdown = getCurrentMarkdown();
  const exportJson = getExportJson();
  const currentNoteType = getCurrentNoteType();
  const hasNote = currentSoap !== null || currentSoap3 !== null;
  
  // Check if the editor mode dropdown differs from the current note's type
  const showModeSwitchBanner = hasNote && currentNoteType !== preferences.noteEditorMode;

  return (
    <DemoModeGuard>
      <DemoModeBanner />
      <div className="min-h-screen bg-background p-4">
        <div className="max-w-4xl mx-auto space-y-6">
          {/* Header */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-xl">DocNoteAI</CardTitle>
                <div className="flex items-center gap-4">
                  <ResetDemoAckButton />
                  <span className="text-sm text-muted-foreground">{user.email}</span>
                  <Button onClick={handleClearSession} variant="outline" size="sm">
                    <Trash2 className="h-4 w-4 mr-2" />
                    Clear Session
                  </Button>
                  <Button onClick={handleLogout} variant="outline" size="sm">
                    <LogOut className="h-4 w-4 mr-2" />
                    Log Out
                  </Button>
                </div>
              </div>
            </CardHeader>
          </Card>

        {/* Conflict Banner - now rendered inside SOAP Note section */}

        {/* Mode Mismatch Warning */}
        {modeMismatchWarning && (
          <Card className="border-orange-500 bg-orange-50 dark:bg-orange-950/20">
            <CardContent className="py-4">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <AlertTriangle className="h-5 w-5 text-orange-600" />
                  <span className="text-sm font-medium">
                    {modeMismatchWarning}
                  </span>
                </div>
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={clearModeMismatchWarning}
                >
                  Dismiss
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Live Scribe Section */}
        <Card className="border-primary/50">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg flex items-center gap-2">
                <Radio className="h-5 w-5 text-primary" />
                Live Scribe (Fast Mode)
              </CardTitle>
              <div className="flex items-center gap-2">
                {/* Timer display - always visible to prevent layout shift */}
                <span className={`text-sm font-mono tabular-nums ${
                  liveScribe.status === 'recording' ? 'text-red-600 dark:text-red-400' :
                  liveScribe.status === 'paused' ? 'text-amber-600 dark:text-amber-400' :
                  liveScribe.status === 'finalizing' ? 'text-amber-600 dark:text-amber-400' :
                  'text-muted-foreground'
                }`}>
                  {formatRecordingTime(liveScribe.recordingElapsedMs)}
                </span>
                <span className={`text-xs px-2 py-1 rounded-full font-medium ${
                  liveScribe.status === 'idle' ? 'bg-muted text-muted-foreground' :
                  liveScribe.status === 'recording' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 animate-pulse' :
                  liveScribe.status === 'paused' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' :
                  liveScribe.status === 'finalizing' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' :
                  liveScribe.status === 'done' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
                  'bg-red-100 text-red-700'
                }`}>
                  {liveScribe.status === 'idle' && 'Idle'}
                  {liveScribe.status === 'recording' && '● Recording'}
                  {liveScribe.status === 'paused' && '⏸ Paused'}
                  {liveScribe.status === 'finalizing' && 'Finalizing'}
                  {liveScribe.status === 'done' && 'Done'}
                  {liveScribe.status === 'error' && 'Error'}
                </span>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Live Draft Mode Toggle */}
            <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50 border">
              <div className="space-y-1">
                <Label className="text-sm font-medium">Live Draft Mode</Label>
                <p className="text-xs text-muted-foreground">
                  {docSession.liveDraftMode === 'A' 
                    ? 'Final note generated after recording stops'
                    : 'Running summary updates during recording'}
                </p>
              </div>
              <Select
                value={docSession.liveDraftMode}
                onValueChange={(value: 'A' | 'B') => setLiveDraftMode(value)}
                disabled={liveScribe.status === 'recording'}
              >
                <SelectTrigger className="w-[200px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="A">Final Note Only (A)</SelectItem>
                  <SelectItem value="B">Running Summary + Final (B)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Recording Controls - context-sensitive based on status */}
            <div className="flex gap-3">
              {/* Idle state: Show Start button */}
              {(liveScribe.status === 'idle' || liveScribe.status === 'done' || liveScribe.status === 'error') && (
                <Button
                  onClick={handleStartLiveScribe}
                  variant="default"
                  className="flex-1"
                >
                  <Mic className="h-4 w-4 mr-2" />
                  Start Live Recording
                </Button>
              )}
              
              {/* Recording state: Show Pause and Stop buttons */}
              {liveScribe.status === 'recording' && (
                <>
                  <Button
                    onClick={() => liveScribe.pauseRecording()}
                    variant="outline"
                    className="flex-1"
                  >
                    <Pause className="h-4 w-4 mr-2" />
                    Pause
                  </Button>
                  <Button
                    onClick={handleStopLiveScribe}
                    variant="destructive"
                    className="flex-1"
                  >
                    <Square className="h-4 w-4 mr-2" />
                    Stop Recording
                  </Button>
                </>
              )}
              
              {/* Paused state: Show Resume and Stop buttons */}
              {liveScribe.status === 'paused' && (
                <>
                  <Button
                    onClick={() => liveScribe.resumeRecording()}
                    variant="default"
                    className="flex-1"
                  >
                    <Play className="h-4 w-4 mr-2" />
                    Resume
                  </Button>
                  <Button
                    onClick={handleStopLiveScribe}
                    variant="destructive"
                    className="flex-1"
                  >
                    <Square className="h-4 w-4 mr-2" />
                    Stop Recording
                  </Button>
                </>
              )}
              
              {/* Finalizing state: Show disabled state */}
              {liveScribe.status === 'finalizing' && (
                <Button
                  disabled
                  variant="outline"
                  className="flex-1"
                >
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Finalizing...
                </Button>
              )}
            </div>

            {/* Running Summary Panel (Option B only) - show during recording, paused, or if summary exists */}
            {docSession.liveDraftMode === 'B' && (liveScribe.status === 'recording' || liveScribe.status === 'paused' || docSession.runningSummary) && (
              <div className="space-y-2 p-4 rounded-lg border-2 border-primary/30 bg-primary/5">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium flex items-center gap-2">
                    <FileText className="h-4 w-4 text-primary" />
                    Running Summary
                    {liveScribe.status === 'recording' && (
                      <span className="text-xs text-muted-foreground">(updates every ~75s)</span>
                    )}
                    {liveScribe.status === 'paused' && (
                      <span className="text-xs text-muted-foreground">(paused)</span>
                    )}
                  </Label>
                  {docSession.runningSummary && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => copyToClipboard(docSession.runningSummary || '', 'Summary')}
                      className="flex items-center gap-1"
                    >
                      {copiedField === 'Summary' ? (
                        <Check className="h-3 w-3" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                      Copy Summary
                    </Button>
                  )}
                </div>
                <pre className="bg-background p-4 rounded-md text-sm overflow-auto max-h-48 whitespace-pre-wrap font-mono border">
                  {docSession.runningSummary || (liveScribe.status === 'recording' ? 'Summary will appear here...' : 'No summary yet.')}
                </pre>
              </div>
            )}

            {/* Live Transcript Display - show during recording, paused, or if transcript exists */}
            {(liveScribe.status === 'recording' || liveScribe.status === 'paused' || liveScribe.transcript) && (
              <div className="space-y-2">
                <Label className="text-sm font-medium">
                  Live Transcript
                  {liveScribe.status === 'paused' && <span className="text-xs text-muted-foreground ml-2">(paused)</span>}
                </Label>
                <pre 
                  ref={liveTranscriptRef}
                  className="bg-muted p-4 rounded-md text-sm overflow-auto max-h-48 whitespace-pre-wrap font-mono border"
                >
                  {liveScribe.transcript || (liveScribe.status === 'recording' ? 'Listening...' : liveScribe.status === 'paused' ? 'Paused...' : '')}
                </pre>
              </div>
            )}

            {/* Debug Info Panel */}
            {(liveScribe.status !== 'idle' || liveScribe.debugInfo.lastLiveError || liveScribe.debugInfo.lastSummaryError) && (
              <div className="space-y-2 p-3 rounded-lg bg-muted/50 border text-xs font-mono">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-foreground">Debug Info</span>
                  <span className="text-muted-foreground">
                    Chunks: {liveScribe.debugInfo.chunksSent} | Transcript: {liveScribe.debugInfo.totalTranscriptLength} chars
                  </span>
                </div>
                
                {/* Audio Format Info */}
                <div className="grid grid-cols-4 gap-2 text-muted-foreground bg-background/50 p-2 rounded">
                  <div>
                    <span className="text-foreground text-[10px] uppercase">Input Rate</span>
                    <div className="text-foreground">{liveScribe.debugInfo.inputSampleRate ? `${liveScribe.debugInfo.inputSampleRate} Hz` : '—'}</div>
                  </div>
                  <div>
                    <span className="text-foreground text-[10px] uppercase">Output Rate</span>
                    <div className="text-foreground">{liveScribe.debugInfo.outputSampleRate} Hz</div>
                  </div>
                  <div>
                    <span className="text-foreground text-[10px] uppercase">Encoding</span>
                    <div className="text-foreground">{liveScribe.debugInfo.encoding}</div>
                  </div>
                  <div>
                    <span className="text-foreground text-[10px] uppercase">Bytes/Chunk</span>
                    <div className="text-foreground">{liveScribe.debugInfo.bytesPerChunk ? `${(liveScribe.debugInfo.bytesPerChunk / 1024).toFixed(1)} KB` : '—'}</div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 text-muted-foreground">
                  <div>
                    <span className="text-foreground">Live API:</span>{' '}
                    <span className={
                      liveScribe.debugInfo.lastLiveStatus === 'calling' ? 'text-amber-500' :
                      liveScribe.debugInfo.lastLiveStatus === 'received' ? 'text-green-500' :
                      liveScribe.debugInfo.lastLiveStatus === 'error' ? 'text-destructive' :
                      'text-muted-foreground'
                    }>
                      {liveScribe.debugInfo.lastLiveStatus}
                    </span>
                    {liveScribe.debugInfo.lastLiveCallAt && (
                      <span className="ml-2 text-muted-foreground">
                        @ {new Date(liveScribe.debugInfo.lastLiveCallAt).toLocaleTimeString()}
                      </span>
                    )}
                    {liveScribe.debugInfo.chunksWithNoTranscript > 0 && (
                      <span className="ml-2 text-amber-500">
                        ({liveScribe.debugInfo.chunksWithNoTranscript} empty)
                      </span>
                    )}
                  </div>
                  {docSession.liveDraftMode === 'B' && (
                    <div>
                      <span className="text-foreground">Summary API:</span>{' '}
                      {liveScribe.debugInfo.lastSummaryCallAt ? (
                        <span className="text-green-500">
                          called @ {new Date(liveScribe.debugInfo.lastSummaryCallAt).toLocaleTimeString()}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">not called yet</span>
                      )}
                    </div>
                  )}
                </div>
                {liveScribe.debugInfo.lastLiveError && (
                  <div className="text-destructive bg-destructive/10 p-2 rounded">
                    <strong>Live Error:</strong> {liveScribe.debugInfo.lastLiveError}
                  </div>
                )}
                {liveScribe.debugInfo.lastSummaryError && (
                  <div className="text-destructive bg-destructive/10 p-2 rounded">
                    <strong>Summary Error:</strong> {liveScribe.debugInfo.lastSummaryError}
                  </div>
                )}
              </div>
            )}

            {liveScribe.error && (
              <div className="text-sm text-destructive bg-destructive/10 p-3 rounded-md">
                {liveScribe.error}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Controls */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Batch Transcription Controls</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Button onClick={handleTestAuth} disabled={isTestingAuth}>
                {isTestingAuth ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <ShieldCheck className="h-4 w-4 mr-2" />
                )}
                Test Auth
              </Button>
              
              <Button 
                onClick={handleStartBatchLatest} 
                disabled={isStartingBatch} 
                variant="secondary"
              >
                {isStartingBatch ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Play className="h-4 w-4 mr-2" />
                )}
                Start Batch (Latest Audio)
              </Button>
            </div>

            {authCheckResult && (
              <pre className="bg-muted p-3 rounded-md text-sm overflow-auto max-h-32 font-mono">
                {authCheckResult}
              </pre>
            )}
            
            {startBatchResult && (
              <pre className="bg-muted p-3 rounded-md text-sm overflow-auto max-h-32 font-mono">
                {startBatchResult}
              </pre>
            )}

            <div className="flex gap-3 items-end">
              <div className="flex-1 space-y-2">
                <Label htmlFor="jobName">Job Name</Label>
                <Input
                  id="jobName"
                  placeholder="Enter jobName..."
                  value={docSession.jobName ?? ''}
                  onChange={(e) => setJobName(e.target.value)}
                  className="font-mono"
                />
              </div>
              <Button 
                onClick={() => handleTestBatchStatus()} 
                disabled={isTestingBatchStatus || !docSession.jobName?.trim()}
              >
                {isTestingBatchStatus ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <ShieldCheck className="h-4 w-4 mr-2" />
                )}
                Test Batch Status
              </Button>
            </div>
            
            {batchStatusResult && (
              <pre className="bg-muted p-3 rounded-md text-sm overflow-auto max-h-40 font-mono">
                {batchStatusResult}
              </pre>
            )}

            {/* Physician Preferences Panel */}
            <div className="border rounded-lg p-4 bg-muted/30">
              <div className="flex items-center gap-2 mb-4">
                <Settings className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium text-sm">Physician Preferences</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="noteEditorMode" className="text-sm">Editor Mode</Label>
                  <Select
                    value={preferences.noteEditorMode}
                    onValueChange={(value: NoteEditorMode) => 
                      setPreferences({ noteEditorMode: value })
                    }
                  >
                    <SelectTrigger id="noteEditorMode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="SOAP_4_FIELD">SOAP (4 fields: S / O / A / P)</SelectItem>
                      <SelectItem value="SOAP_3_FIELD">SOAP (3 fields: S / O / A&P combined)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="noteStructure" className="text-sm">Note Structure</Label>
                  <Select
                    value={preferences.noteStructure}
                    onValueChange={(value: 'SOAP' | 'Problem-Oriented') => 
                      setPreferences({ noteStructure: value })
                    }
                  >
                    <SelectTrigger id="noteStructure">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="SOAP">SOAP</SelectItem>
                      <SelectItem value="Problem-Oriented">Problem-Oriented</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="detailLevel" className="text-sm">Detail Level</Label>
                  <Select
                    value={preferences.detailLevel}
                    onValueChange={(value: 'Brief' | 'Standard' | 'Detailed') => 
                      setPreferences({ detailLevel: value })
                    }
                  >
                    <SelectTrigger id="detailLevel">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Brief">Brief</SelectItem>
                      <SelectItem value="Standard">Standard</SelectItem>
                      <SelectItem value="Detailed">Detailed</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="planFormat" className="text-sm">Plan Format</Label>
                  <Select
                    value={preferences.planFormat}
                    onValueChange={(value: 'Bullets' | 'Paragraph') => 
                      setPreferences({ planFormat: value })
                    }
                  >
                    <SelectTrigger id="planFormat">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Bullets">Bullets</SelectItem>
                      <SelectItem value="Paragraph">Paragraph</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center justify-between">
                  <Label htmlFor="firstPerson" className="text-sm cursor-pointer">
                    First-person clinician voice
                  </Label>
                  <Switch
                    id="firstPerson"
                    checked={preferences.firstPerson}
                    onCheckedChange={(checked) => setPreferences({ firstPerson: checked })}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <Label htmlFor="patientQuotes" className="text-sm cursor-pointer">
                    Include patient quotes
                  </Label>
                  <Switch
                    id="patientQuotes"
                    checked={preferences.patientQuotes}
                    onCheckedChange={(checked) => setPreferences({ patientQuotes: checked })}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <Label htmlFor="assessmentProblemList" className="text-sm cursor-pointer">
                    Assessment as problem list
                  </Label>
                  <Switch
                    id="assessmentProblemList"
                    checked={preferences.assessmentProblemList}
                    onCheckedChange={(checked) => setPreferences({ assessmentProblemList: checked })}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <Label htmlFor="includeFollowUpLine" className="text-sm cursor-pointer">
                    Plan includes follow-up line
                  </Label>
                  <Switch
                    id="includeFollowUpLine"
                    checked={preferences.includeFollowUpLine}
                    onCheckedChange={(checked) => setPreferences({ includeFollowUpLine: checked })}
                  />
                </div>
              </div>

              {/* Patient Instructions Settings */}
              <div className="mt-4 pt-4 border-t border-border">
                <Label className="text-sm font-medium mb-3 block">Patient Instructions Settings</Label>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="patientFirstName" className="text-sm">Patient First Name (for greeting)</Label>
                    <Input
                      id="patientFirstName"
                      value={preferences.patientFirstName}
                      onChange={(e) => setPreferences({ patientFirstName: e.target.value })}
                      placeholder="e.g., John"
                      className="text-sm"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="clinicianDisplayName" className="text-sm">Clinician Name (for signature)</Label>
                    <Input
                      id="clinicianDisplayName"
                      value={preferences.clinicianDisplayName}
                      onChange={(e) => setPreferences({ clinicianDisplayName: e.target.value })}
                      placeholder="e.g., Dr. Jane Smith"
                      className="text-sm"
                    />
                  </div>
                </div>
              </div>
              
              {/* Custom Style Instructions */}
              <div className="mt-4 space-y-2">
                <Label htmlFor="styleText" className="text-sm">My style preferences (optional)</Label>
                <AutoResizeTextarea
                  id="styleText"
                  value={preferences.styleText}
                  onChange={(e) => setPreferences({ styleText: e.target.value })}
                  placeholder="Examples:
• Keep assessment as problem list, no sentences.
• Plan should include return precautions when mentioned.
• Avoid filler like 'patient presents today'."
                  className="min-h-[80px] text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  Style only. Cannot add facts not in transcript. ({preferences.styleText.length}/600)
                </p>
              </div>
            </div>

            <div className="space-y-2">
              {docSession.transcriptText && (
                <div className="text-xs text-muted-foreground flex items-center justify-between">
                  <span>
                    Using transcript from: <strong>{liveScribe.status !== 'idle' || liveScribe.transcript ? 'Live' : 'Batch'}</strong>
                  </span>
                  <span>{docSession.transcriptText.length} chars</span>
                </div>
              )}
              <Button 
                onClick={handleGenerateSoap} 
                disabled={isGeneratingSoap || !docSession.transcriptText} 
                className="w-full"
                variant="default"
              >
                {isGeneratingSoap ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <FileText className="h-4 w-4 mr-2" />
                )}
                {!docSession.transcriptText ? 'No transcript available' : 'Generate SOAP'}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* SOAP Note Section */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">
                SOAP Note
                {currentNoteType && (
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    ({currentNoteType === 'SOAP_4_FIELD' ? '4-field' : '3-field'})
                  </span>
                )}
              </CardTitle>
              {hasNote && (
                <div className="flex gap-2">
                  <CopyButton 
                    text={currentMarkdown} 
                    label="Copy SOAP" 
                  />
                  <CopyButton 
                    text={exportJson} 
                    label="Copy JSON" 
                  />
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {/* Mode Switch Banner - shown when dropdown mode differs from current note type */}
            {showModeSwitchBanner && (
              <div 
                ref={modeSwitchBannerRef}
                className="mb-4 p-4 rounded-lg border border-blue-500 bg-blue-50 dark:bg-blue-950/20"
              >
                <div className="flex items-center justify-between gap-4 flex-wrap">
                  <div className="flex items-center gap-3">
                    <AlertTriangle className="h-5 w-5 text-blue-600 flex-shrink-0" />
                    <span className="text-sm font-medium">
                      Editor mode changed. Regenerate the note to apply the new format.
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <Button 
                      variant="outline" 
                      size="sm" 
                      onClick={() => setPreferences({ noteEditorMode: currentNoteType as NoteEditorMode })}
                    >
                      Keep current note
                    </Button>
                    <Button 
                      variant="default" 
                      size="sm" 
                      onClick={handleGenerateSoap}
                      disabled={isGeneratingSoap || !docSession.transcriptText}
                    >
                      {isGeneratingSoap ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <RefreshCw className="h-4 w-4 mr-2" />
                      )}
                      Regenerate in {preferences.noteEditorMode === 'SOAP_3_FIELD' ? 'SOAP (3 fields)' : 'SOAP (4 fields)'}
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {/* Conflict Banner - positioned directly above SOAP fields */}
            {showConflictBanner && (
              <div 
                ref={conflictBannerRef}
                className="mb-4 p-4 rounded-lg border border-amber-500 bg-amber-50 dark:bg-amber-950/20"
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <AlertTriangle className="h-5 w-5 text-amber-600 flex-shrink-0" />
                    <span className="text-sm font-medium">
                      New AI note generated. Replace your edits?
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <Button 
                      variant="outline" 
                      size="sm" 
                      onClick={keepUserEdits}
                    >
                      Keep my edits
                    </Button>
                    <Button 
                      variant="default" 
                      size="sm" 
                      onClick={acceptNewGenerated}
                    >
                      Replace edits
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {/* 4-FIELD MODE */}
            {currentSoap && currentNoteType === 'SOAP_4_FIELD' && (
              <div className="space-y-4">
                {/* Editable SOAP Cards - 4 Fields */}
                <div className="space-y-4">
                  <div className="border rounded-lg p-4 bg-card">
                    <div className="flex items-center justify-between mb-2">
                      <Label htmlFor="soap-subjective" className="font-semibold text-sm text-primary uppercase tracking-wide">
                        Subjective
                      </Label>
                      <SectionCopyButton text={currentSoap.subjective || ''} sectionName="Subjective" />
                    </div>
                    <AutoResizeTextarea
                      id="soap-subjective"
                      value={currentSoap.subjective || ''}
                      onChange={(e) => editSoapField('subjective', e.target.value)}
                      placeholder="Not documented."
                    />
                  </div>
                  
                  <div className="border rounded-lg p-4 bg-card">
                    <div className="flex items-center justify-between mb-2">
                      <Label htmlFor="soap-objective" className="font-semibold text-sm text-primary uppercase tracking-wide">
                        Objective
                      </Label>
                      <SectionCopyButton text={currentSoap.objective || ''} sectionName="Objective" />
                    </div>
                    <AutoResizeTextarea
                      id="soap-objective"
                      value={currentSoap.objective || ''}
                      onChange={(e) => editSoapField('objective', e.target.value)}
                      placeholder="Not documented."
                    />
                  </div>
                  
                  <div className="border rounded-lg p-4 bg-card">
                    <div className="flex items-center justify-between mb-2">
                      <Label htmlFor="soap-assessment" className="font-semibold text-sm text-primary uppercase tracking-wide">
                        Assessment
                      </Label>
                      <SectionCopyButton text={currentSoap.assessment || ''} sectionName="Assessment" />
                    </div>
                    <AutoResizeTextarea
                      id="soap-assessment"
                      value={currentSoap.assessment || ''}
                      onChange={(e) => editSoapField('assessment', e.target.value)}
                      placeholder="Not documented."
                    />
                  </div>
                  
                  <div className="border rounded-lg p-4 bg-card">
                    <div className="flex items-center justify-between mb-2">
                      <Label htmlFor="soap-plan" className="font-semibold text-sm text-primary uppercase tracking-wide">
                        Plan
                      </Label>
                      <SectionCopyButton text={currentSoap.plan || ''} sectionName="Plan" />
                    </div>
                    <AutoResizeTextarea
                      id="soap-plan"
                      value={currentSoap.plan || ''}
                      onChange={(e) => editSoapField('plan', e.target.value)}
                      placeholder="Not documented."
                    />
                  </div>
                </div>

                {/* Markdown Preview */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <button 
                      onClick={() => setMarkdownExpanded(!docSession.markdownExpanded)}
                      className="text-sm text-muted-foreground hover:text-foreground font-medium cursor-pointer"
                    >
                      {docSession.markdownExpanded ? '▼' : '▶'} View Formatted Markdown
                    </button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={syncMarkdownFromSoap}
                      className="flex items-center gap-1"
                    >
                      <RefreshCw className="h-3 w-3" />
                      Sync Markdown
                    </Button>
                  </div>
                  {docSession.markdownExpanded && (
                    <pre className="bg-muted p-4 rounded-md overflow-auto max-h-64 whitespace-pre-wrap font-mono border text-sm">
                      {currentMarkdown || 'No markdown available.'}
                    </pre>
                  )}
                </div>
              </div>
            )}

            {/* 3-FIELD MODE */}
            {currentSoap3 && currentNoteType === 'SOAP_3_FIELD' && (
              <div className="space-y-4">
                {/* Editable SOAP Cards - 3 Fields */}
                <div className="space-y-4">
                  <div className="border rounded-lg p-4 bg-card">
                    <div className="flex items-center justify-between mb-2">
                      <Label htmlFor="soap3-subjective" className="font-semibold text-sm text-primary uppercase tracking-wide">
                        Subjective
                      </Label>
                      <SectionCopyButton text={currentSoap3.subjective || ''} sectionName="Subjective" />
                    </div>
                    <AutoResizeTextarea
                      id="soap3-subjective"
                      value={currentSoap3.subjective || ''}
                      onChange={(e) => editSoap3Field('subjective', e.target.value)}
                      placeholder="Not documented."
                    />
                  </div>
                  
                  <div className="border rounded-lg p-4 bg-card">
                    <div className="flex items-center justify-between mb-2">
                      <Label htmlFor="soap3-objective" className="font-semibold text-sm text-primary uppercase tracking-wide">
                        Objective
                      </Label>
                      <SectionCopyButton text={currentSoap3.objective || ''} sectionName="Objective" />
                    </div>
                    <AutoResizeTextarea
                      id="soap3-objective"
                      value={currentSoap3.objective || ''}
                      onChange={(e) => editSoap3Field('objective', e.target.value)}
                      placeholder="Not documented."
                    />
                  </div>
                  
                  <div className="border rounded-lg p-4 bg-card">
                    <div className="flex items-center justify-between mb-2">
                      <Label htmlFor="soap3-assessmentPlan" className="font-semibold text-sm text-primary uppercase tracking-wide">
                        Assessment & Plan
                      </Label>
                      <SectionCopyButton text={currentSoap3.assessmentPlan || ''} sectionName="Assessment & Plan" />
                    </div>
                    <AutoResizeTextarea
                      id="soap3-assessmentPlan"
                      value={currentSoap3.assessmentPlan || ''}
                      onChange={(e) => editSoap3Field('assessmentPlan', e.target.value)}
                      placeholder="Not documented."
                    />
                  </div>
                </div>

                {/* AP Problem List (read-only info) */}
                {currentAp && currentAp.length > 0 && (
                  <div className="border rounded-lg p-4 bg-muted/30">
                    <Label className="font-semibold text-sm text-muted-foreground mb-2 uppercase tracking-wide block">
                      Problem Breakdown ({currentAp.length} problem{currentAp.length > 1 ? 's' : ''})
                    </Label>
                    <div className="space-y-2 text-sm">
                      {currentAp.map((entry, idx) => (
                        <div key={idx} className="border-l-2 border-primary/30 pl-3">
                          <strong>{idx + 1}. {entry.problem}</strong>
                          <div className="text-muted-foreground">Assessment: {entry.assessment}</div>
                          <div className="text-muted-foreground">
                            Plan: {entry.plan.join(', ')}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Markdown Preview */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <button 
                      onClick={() => setMarkdownExpanded(!docSession.markdownExpanded)}
                      className="text-sm text-muted-foreground hover:text-foreground font-medium cursor-pointer"
                    >
                      {docSession.markdownExpanded ? '▼' : '▶'} View Formatted Markdown
                    </button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={syncMarkdownFromSoap3}
                      className="flex items-center gap-1"
                    >
                      <RefreshCw className="h-3 w-3" />
                      Sync Markdown
                    </Button>
                  </div>
                  {docSession.markdownExpanded && (
                    <pre className="bg-muted p-4 rounded-md overflow-auto max-h-64 whitespace-pre-wrap font-mono border text-sm">
                      {currentMarkdown || 'No markdown available.'}
                    </pre>
                  )}
                </div>
              </div>
            )}

            {/* No note yet */}
            {!hasNote && (
              <div className="bg-muted/50 p-4 rounded-md text-center text-muted-foreground">
                No SOAP note generated yet. Click "Generate SOAP" after loading a transcript.
              </div>
            )}
          </CardContent>
        </Card>

        {/* Patient Instructions Section */}
        {hasNote && (
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg">Patient Instructions</CardTitle>
                <SectionCopyButton text={getPatientInstructions()} sectionName="Patient Instructions" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="border rounded-lg p-4 bg-card">
                <AutoResizeTextarea
                  id="patient-instructions"
                  value={getPatientInstructions()}
                  onChange={(e) => editPatientInstructions(e.target.value)}
                  placeholder="Patient instructions will be generated here. This is a plain-language letter summarizing the visit for the patient."
                  className="min-h-[120px]"
                />
              </div>
              {!getPatientInstructions() && (
                <p className="text-xs text-muted-foreground mt-2">
                  Patient instructions will be generated when you click "Generate SOAP".
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {/* Transcript Section */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">Transcript</CardTitle>
              {docSession.transcriptText && (
                <CopyButton text={docSession.transcriptText} label="Copy Transcript" />
              )}
            </div>
          </CardHeader>
          <CardContent>
            {docSession.transcriptText ? (
              <pre className="bg-muted p-4 rounded-md text-sm overflow-auto max-h-64 whitespace-pre-wrap font-mono border">
                {docSession.transcriptText}
              </pre>
            ) : (
              <div className="bg-muted/50 p-4 rounded-md text-center text-muted-foreground">
                No transcript loaded yet. Use Live Scribe or run Batch transcription.
              </div>
            )}
          </CardContent>
        </Card>
        </div>
      </div>
    </DemoModeGuard>
  );
};

export default AppHome;
