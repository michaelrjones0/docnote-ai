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
import { RichSoapTextarea } from '@/components/ui/rich-soap-textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Loader2, LogOut, ShieldCheck, Play, FileText, Copy, Check, RefreshCw, Trash2, AlertTriangle, Mic, Square, Radio, Pause, Pencil, UserX } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { useDocNoteSession, isNote4Field, isNote3Field } from '@/hooks/useDocNoteSession';
import { usePhysicianPreferences, NoteEditorMode, PhysicianPreferences, PatientGender, LiveDraftMode } from '@/hooks/usePhysicianPreferences';
import { useLiveScribe } from '@/hooks/useLiveScribe';
import { useHybridLiveScribe } from '@/hooks/useHybridLiveScribe';
import { useBrowserLiveTranscript } from '@/hooks/useBrowserLiveTranscript';
import { useLiveTranscriptEngine } from '@/hooks/useLiveTranscriptEngine';
import { DemoModeGuard, DemoModeBanner, ResetDemoAckButton } from '@/components/DemoModeGuard';
import { SettingsSheet } from '@/components/SettingsSheet';

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
  const [showSignatureModal, setShowSignatureModal] = useState(false);
  const [pendingSignatureName, setPendingSignatureName] = useState('');
  const [signatureNeededMessage, setSignatureNeededMessage] = useState(false);
  const [autoGenerateAfterSignature, setAutoGenerateAfterSignature] = useState(false);
  const [showEndEncounterDialog, setShowEndEncounterDialog] = useState(false);
  const { preferences, setPreferences, addTemplate, updateTemplate, deleteTemplate, setDefaultTemplate } = usePhysicianPreferences();
  
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
  // Check if Deepgram streaming is available
  const deepgramRelayUrl = import.meta.env.VITE_DEEPGRAM_RELAY_URL || '';
  const isStreamingAvailable = Boolean(deepgramRelayUrl);
  
  // Track Deepgram connection state for fallback logic
  const [deepgramConnected, setDeepgramConnected] = useState(false);
  const [deepgramFailed, setDeepgramFailed] = useState(false);
  const connectionTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  // Hybrid Live Scribe (Deepgram streaming) - used when relay is configured
  const hybridLiveScribe = useHybridLiveScribe({
    onTranscriptUpdate: (transcript) => {
      setTranscriptText(transcript);
      setTimeout(() => {
        if (liveTranscriptRef.current) {
          liveTranscriptRef.current.scrollTop = liveTranscriptRef.current.scrollHeight;
        }
      }, 50);
    },
    onSummaryUpdate: (summary) => {
      setRunningSummary(summary);
    },
    onReady: () => {
      // Deepgram relay connected successfully - clear timeout and mark connected
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
      }
      setDeepgramConnected(true);
      setDeepgramFailed(false);
      console.log('[LiveTranscript] Deepgram relay ready (onReady event)');
    },
    onError: (err) => {
      // Deepgram failed - clear timeout and trigger fallback
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
      }
      setDeepgramFailed(true);
      setDeepgramConnected(false);
      console.warn('[LiveTranscript] Deepgram relay error (onError event):', err);
      
      // Start browser fallback
      if (browserTranscript.isSupported) {
        console.log('[LiveTranscript] Starting Browser STT fallback');
        browserTranscript.startListening();
      }
      
      toast({
        title: 'Live Scribe Error',
        description: err,
        variant: 'destructive',
      });
    },
    liveDraftMode: preferences.liveDraftMode,
    preferences,
  });

  // Fallback batch-based Live Scribe - used when streaming is not available
  const batchLiveScribe = useLiveScribe({
    onTranscriptUpdate: (transcript) => {
      setTranscriptText(transcript);
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
    chunkIntervalMs: 10000,
    liveDraftMode: preferences.liveDraftMode,
    preferences,
  });

  // Unified liveScribe interface - use streaming when available, otherwise batch
  const liveScribe = isStreamingAvailable ? hybridLiveScribe : batchLiveScribe;

  // Browser SpeechRecognition for immediate visual feedback - fallback when Deepgram streaming unavailable
  const browserTranscript = useBrowserLiveTranscript();
  
  // Engine selection logic with debug toggle support
  const {
    engineState,
    shouldUseDeepgramForDisplay,
    shouldUseBrowserForDisplay,
    isDebugForced,
    forcedEngine,
  } = useLiveTranscriptEngine({
    deepgramReady: hybridLiveScribe.status === 'recording',
    deepgramConnecting: hybridLiveScribe.status === 'connecting',
    deepgramError: hybridLiveScribe.status === 'error',
    browserListening: browserTranscript.isListening,
    browserSupported: browserTranscript.isSupported,
    isRecording: liveScribe.status === 'recording' || liveScribe.status === 'connecting',
  });
  
  // Derive actual engine being used based on connection state
  const actualEngine = (() => {
    if (isStreamingAvailable && hybridLiveScribe.status === 'recording') return 'deepgram';
    if (browserTranscript.isListening) return 'browser';
    if (liveScribe.status === 'recording') return 'aws'; // chunked backend
    return 'none';
  })();

  const handleStartLiveScribe = async () => {
    // Reset Deepgram connection state
    setDeepgramConnected(false);
    setDeepgramFailed(false);
    
    // Clear any existing connection timeout
    if (connectionTimeoutRef.current) {
      clearTimeout(connectionTimeoutRef.current);
      connectionTimeoutRef.current = null;
    }
    
    // If Deepgram is available, try it first (primary engine)
    if (isStreamingAvailable) {
      // PHI-safe log: connection attempt
      console.log(`[LiveTranscript] Attempting Deepgram relay connection to: ${deepgramRelayUrl}/dictate`);
      
      // Set up 5-second connection timeout - if no onReady arrives, fallback to browser
      connectionTimeoutRef.current = setTimeout(() => {
        if (!deepgramConnected && !deepgramFailed) {
          console.warn('[LiveTranscript] Deepgram relay connection timeout (5s), falling back to Browser STT');
          setDeepgramFailed(true);
          if (browserTranscript.isSupported) {
            browserTranscript.startListening();
          }
        }
      }, 5000);
      
      // Start Deepgram streaming - onReady callback will clear timeout if successful
      await liveScribe.startRecording();
    } else {
      // No Deepgram configured - use browser STT directly
      console.log('[LiveTranscript] No Deepgram relay configured, using Browser STT');
      if (browserTranscript.isSupported) {
        browserTranscript.startListening();
      }
      await liveScribe.startRecording();
    }
  };

  const handleStopLiveScribe = async () => {
    // Clear connection timeout if still pending
    if (connectionTimeoutRef.current) {
      clearTimeout(connectionTimeoutRef.current);
      connectionTimeoutRef.current = null;
    }
    
    // Stop browser transcript (always stop it, might have been fallback)
    browserTranscript.stopListening();
    
    // Stop backend transcription
    const finalTranscript = await liveScribe.stopRecording();
    
    // Auto-generate note if we have a transcript (use backend transcript, not browser)
    if (finalTranscript?.trim()) {
      setTranscriptText(finalTranscript);
      // Small delay to ensure state is updated
      setTimeout(() => {
        handleGenerateSoap();
      }, 100);
    }
  };
  
  // Cleanup connection timeout on unmount
  useEffect(() => {
    return () => {
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
      }
    };
  }, []);

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

    // Check for signature before generating
    const currentPrefs = preferencesRef.current;
    if (!currentPrefs.clinicianDisplayName.trim()) {
      setPendingSignatureName('');
      setShowSignatureModal(true);
      return;
    }

    setIsGeneratingSoap(true);
    setSignatureNeededMessage(false);
    // Always use the latest preferences from ref to avoid stale closure
    const expectedMode = currentPrefs.noteEditorMode;

    // Resolve the active physical exam template content
    const activeTemplateId = currentPrefs.selectedPhysicalExamTemplateId || currentPrefs.defaultPhysicalExamTemplateId;
    const activeTemplate = currentPrefs.physicalExamTemplates.find(t => t.id === activeTemplateId) 
      || currentPrefs.physicalExamTemplates[0];
    const resolvedPrefs = {
      ...currentPrefs,
      selectedPhysicalExamTemplate: activeTemplate?.content || currentPrefs.normalPhysicalTemplate,
    };

    try {
      const { data, error } = await supabase.functions.invoke('generate-note', {
        body: { 
          noteType: 'SOAP',
          transcript,
          preferences: resolvedPrefs
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
          patientName: data.patientName || preferences.patientName || '',
          patientGender: data.patientGender || preferences.patientGender || 'other',
          patientPronouns: data.patientPronouns || { subject: 'they', object: 'them', possessive: 'their' },
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
          patientName: data.patientName || preferences.patientName || '',
          patientGender: data.patientGender || preferences.patientGender || 'other',
          patientPronouns: data.patientPronouns || { subject: 'they', object: 'them', possessive: 'their' },
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

  // Handler for saving signature - sets flag for effect-based generation
  const handleSaveSignature = useCallback(() => {
    const trimmedName = pendingSignatureName.trim();
    if (!trimmedName) {
      toast({
        title: 'Signature required',
        description: 'Please enter your signature name.',
        variant: 'destructive',
      });
      return;
    }
    setPreferences({ clinicianDisplayName: trimmedName });
    setShowSignatureModal(false);
    setSignatureNeededMessage(false);
    setAutoGenerateAfterSignature(true);
  }, [pendingSignatureName, setPreferences, toast]);

  // Effect: trigger generation exactly once after signature is saved
  useEffect(() => {
    if (autoGenerateAfterSignature && preferences.clinicianDisplayName.trim()) {
      setAutoGenerateAfterSignature(false);
      handleGenerateSoap();
    }
  }, [autoGenerateAfterSignature, preferences.clinicianDisplayName, handleGenerateSoap]);

  const handleCancelSignature = useCallback(() => {
    setShowSignatureModal(false);
    setSignatureNeededMessage(true);
  }, []);

  const handleOpenSignatureModal = useCallback(() => {
    setPendingSignatureName(preferences.clinicianDisplayName);
    setShowSignatureModal(true);
  }, [preferences.clinicianDisplayName]);

  // Handler for ending encounter and starting fresh
  const handleEndEncounter = useCallback(() => {
    // Clear session data (transcript, notes, running summary)
    clearSession();
    
    // Clear live scribe state if any
    if (liveScribe.status !== 'idle') {
      // Force reset live scribe internal state - handled by clearSession already
    }
    
    // Reset browser transcript
    browserTranscript.reset();
    
    // Clear patient-specific fields from preferences (keep clinician settings)
    setPreferences({ 
      patientName: '', 
      patientGender: '' 
    });
    
    // Close dialog
    setShowEndEncounterDialog(false);
    
    toast({
      title: 'Encounter ended',
      description: 'Ready for a new patient. Please enter patient info to begin.',
    });
  }, [clearSession, liveScribe.status, browserTranscript, setPreferences, toast]);

  // Convert plain text with Title Case: headers to HTML with bold formatting
  const convertTextToRichHtml = (text: string): string => {
    if (!text) return '';
    
    const lines = text.split('\n');
    const htmlLines = lines.map(line => {
      // Check for markdown headers (## Header or # Header)
      const markdownMatch = line.match(/^(#{1,3})\s+(.*)$/);
      if (markdownMatch) {
        const [, , headerText] = markdownMatch;
        return `<b>${headerText}</b>`;
      }
      
      // Check for Title Case: pattern (e.g., "Essential Hypertension:" or "HEENT:")
      const headerMatch = line.match(/^([A-Z][A-Za-z0-9\s/&-]*):(.*)$/);
      if (headerMatch) {
        const [, header, rest] = headerMatch;
        return `<b>${header}:</b>${rest}`;
      }
      
      return line;
    });
    
    return htmlLines.join('<br>');
  };

  // Copy with both rich HTML and plain text for Word/Google Docs compatibility
  const copyRichText = async (text: string): Promise<boolean> => {
    try {
      const html = convertTextToRichHtml(text);
      const htmlBlob = new Blob([html], { type: 'text/html' });
      const textBlob = new Blob([text], { type: 'text/plain' });
      
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': htmlBlob,
          'text/plain': textBlob,
        }),
      ]);
      return true;
    } catch {
      // Fallback to plain text if rich copy fails
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        return false;
      }
    }
  };

  const copyToClipboard = async (text: string, fieldName: string) => {
    try {
      const success = await copyRichText(text);
      if (success) {
        setCopiedField(fieldName);
        toast({
          title: 'Copied!',
          description: `${fieldName} copied to clipboard.`,
        });
        setTimeout(() => setCopiedField(null), 2000);
      } else {
        throw new Error('Copy failed');
      }
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
        const success = await copyRichText(text);
        if (success) {
          setCopied(true);
          setTimeout(() => {
            setCopied(false);
            setDisabled(false);
          }, 1500);
        } else {
          throw new Error('Copy failed');
        }
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
    // Clear encounter-scoped session data
    clearSession();
    setBatchStatusResult(null);
    setStartBatchResult(null);
    setAuthCheckResult(null);
    
    // Clear encounter-scoped patient fields from preferences (keep physician-scoped)
    setPreferences({ 
      patientName: '', 
      patientGender: '' 
    });
    
    toast({
      title: 'Session cleared',
      description: 'Encounter data and patient info cleared. Ready for a new patient.',
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
      <div className="min-h-screen bg-background">
        {/* Clean Header Bar */}
        <header className="sticky top-0 z-50 bg-background border-b">
          <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <span className="text-xl font-semibold tracking-tight">DocNoteAI</span>
            </div>
            <div className="flex items-center gap-3">
              <ResetDemoAckButton />
              <SettingsSheet 
                preferences={preferences} 
                setPreferences={setPreferences}
                addTemplate={addTemplate}
                updateTemplate={updateTemplate}
                deleteTemplate={deleteTemplate}
                setDefaultTemplate={setDefaultTemplate}
              />
              <Button onClick={handleClearSession} variant="ghost" size="sm">
                <Trash2 className="h-4 w-4" />
              </Button>
              <Button onClick={handleLogout} variant="ghost" size="sm">
                <LogOut className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </header>

        <div className="max-w-5xl mx-auto px-4 py-8 space-y-8">

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
        <Card className="border rounded-lg shadow-sm">
          <CardContent className="p-6 space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">New Encounter</h2>
              <div className="flex items-center gap-3">
                {/* Timer display */}
                <span className={`text-sm font-mono tabular-nums ${
                  liveScribe.status === 'recording' ? 'text-destructive' :
                  liveScribe.status === 'paused' ? 'text-muted-foreground' :
                  'text-muted-foreground'
                }`}>
                  {formatRecordingTime(liveScribe.recordingElapsedMs)}
                </span>
                <span className={`text-xs px-2 py-1 rounded-full font-medium ${
                  liveScribe.status === 'idle' ? 'bg-muted text-muted-foreground' :
                  liveScribe.status === 'recording' ? 'bg-destructive/10 text-destructive animate-pulse' :
                  liveScribe.status === 'paused' ? 'bg-muted text-muted-foreground' :
                  liveScribe.status === 'finalizing' ? 'bg-muted text-muted-foreground' :
                  liveScribe.status === 'done' ? 'bg-muted text-foreground' :
                  'bg-destructive/10 text-destructive'
                }`}>
                  {liveScribe.status === 'idle' && 'Ready'}
                  {liveScribe.status === 'recording' && '● Recording'}
                  {liveScribe.status === 'paused' && 'Paused'}
                  {liveScribe.status === 'finalizing' && 'Finalizing'}
                  {liveScribe.status === 'done' && 'Done'}
                  {liveScribe.status === 'error' && 'Error'}
                </span>
              </div>
            </div>
            
            {/* Patient Info - Required before recording */}
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Patient Name */}
                <div className="space-y-2">
                  <Label htmlFor="patientName" className="text-sm font-medium">Patient Name <span className="text-destructive">*</span></Label>
                  <Input
                    id="patientName"
                    value={preferences.patientName}
                    onChange={(e) => setPreferences({ patientName: e.target.value })}
                    placeholder="e.g., John Smith"
                  />
                </div>

                {/* Patient Gender - Segmented Control */}
                <div className="space-y-2">
                  <Label className="text-sm font-medium">Patient Gender <span className="text-destructive">*</span></Label>
                  <div className="flex rounded-lg border overflow-hidden">
                    {(['male', 'female', 'other'] as PatientGender[]).map((gender) => (
                      <button
                        key={gender}
                        type="button"
                        onClick={() => setPreferences({ patientGender: gender })}
                        className={`flex-1 px-3 py-2 text-sm font-medium transition-colors ${
                          preferences.patientGender === gender
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-background hover:bg-muted text-foreground'
                        } ${gender !== 'male' ? 'border-l' : ''}`}
                      >
                        {gender.charAt(0).toUpperCase() + gender.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Live Draft Mode Toggle */}
            <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50 border">
              <div className="space-y-1">
                <Label className="text-sm font-medium">Live Draft Mode</Label>
                <p className="text-xs text-muted-foreground">
                  {preferences.liveDraftMode === 'A' 
                    ? 'Final note generated after recording stops'
                    : 'Running summary updates during recording'}
                </p>
              </div>
              <Select
                value={preferences.liveDraftMode}
                onValueChange={(value: 'A' | 'B') => setPreferences({ liveDraftMode: value })}
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
            <div className="flex flex-col gap-2">
              {/* Validation message when patient info missing */}
              {(!preferences.patientName.trim() || !preferences.patientGender) && (
                <p className="text-xs text-destructive text-center">
                  Please fill in Patient Name and Gender above to start recording
                </p>
              )}
              <div className="flex gap-3">
                {/* Idle state: Show Start button */}
                {(liveScribe.status === 'idle' || liveScribe.status === 'done' || liveScribe.status === 'error') && (
                  <Button
                    onClick={handleStartLiveScribe}
                    variant="default"
                    className="flex-1"
                    disabled={!preferences.patientName.trim() || !preferences.patientGender}
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
              
              {/* End Encounter Button - always visible when not actively recording */}
              {liveScribe.status !== 'recording' && liveScribe.status !== 'paused' && liveScribe.status !== 'finalizing' && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowEndEncounterDialog(true)}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <UserX className="h-4 w-4 mr-2" />
                  End Encounter / New Patient
                </Button>
              )}
            </div>

            {/* Running Summary Panel (Option B only) - show during recording, paused, or if summary exists */}
            {preferences.liveDraftMode === 'B' && (liveScribe.status === 'recording' || liveScribe.status === 'paused' || docSession.runningSummary) && (
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
            {(liveScribe.status === 'recording' || liveScribe.status === 'paused' || liveScribe.transcript || browserTranscript.finalText) && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium flex items-center gap-2">
                    Live Transcript
                    {liveScribe.status === 'paused' && <span className="text-xs text-muted-foreground">(paused)</span>}
                  </Label>
                  
                  {/* Engine Indicator - always visible during recording */}
                  {(liveScribe.status === 'recording' || liveScribe.status === 'connecting') && (
                    <div className="flex items-center gap-2">
                      <span className={`text-xs font-mono px-2 py-0.5 rounded ${
                        actualEngine === 'deepgram' 
                          ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' 
                          : actualEngine === 'browser'
                          ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                          : liveScribe.status === 'connecting'
                          ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
                          : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                      }`}>
                        {actualEngine === 'deepgram' && (
                          <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse mr-1.5" />
                        )}
                        {actualEngine === 'browser' && (
                          <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse mr-1.5" />
                        )}
                        {liveScribe.status === 'connecting' && actualEngine === 'none' && (
                          <span className="inline-block w-1.5 h-1.5 rounded-full bg-yellow-500 animate-pulse mr-1.5" />
                        )}
                        {actualEngine === 'deepgram' ? 'Deepgram STT' : 
                         actualEngine === 'browser' ? 'Browser STT' : 
                         actualEngine === 'aws' ? 'AWS Chunked' : 
                         'Connecting...'}
                      </span>
                      {isDebugForced && (
                        <span className="text-xs text-purple-600 dark:text-purple-400 font-mono">
                          [DEBUG: {forcedEngine}]
                        </span>
                      )}
                    </div>
                  )}
                </div>
                
                {/* Fallback Warning Banner */}
                {engineState.fallbackWarning && (
                  <div className="flex items-center gap-2 px-3 py-2 bg-orange-100 dark:bg-orange-900/20 text-orange-800 dark:text-orange-300 rounded-md text-xs">
                    <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
                    <span>{engineState.fallbackWarning}</span>
                  </div>
                )}
                
                <pre 
                  ref={liveTranscriptRef}
                  className="bg-muted p-4 rounded-md text-sm overflow-auto max-h-48 whitespace-pre-wrap font-mono border"
                >
                  {/* During recording: Deepgram is primary, Browser STT is fallback */}
                  {liveScribe.status === 'recording' ? (
                    /* Priority: Deepgram > Browser STT > Chunked backend */
                    actualEngine === 'deepgram' ? (
                      /* Deepgram streaming: show final + partial (punctuated) */
                      <>
                        {hybridLiveScribe.transcript || ''}
                        {hybridLiveScribe.partialTranscript && (
                          <span className="text-muted-foreground">{hybridLiveScribe.transcript ? ' ' : ''}{hybridLiveScribe.partialTranscript}</span>
                        )}
                        {!hybridLiveScribe.transcript && !hybridLiveScribe.partialTranscript && 'Listening...'}
                      </>
                    ) : actualEngine === 'browser' ? (
                      /* Browser STT fallback */
                      <>
                        {browserTranscript.finalText || ''}
                        {browserTranscript.interimText && (
                          <span className="text-muted-foreground">{browserTranscript.finalText ? ' ' : ''}{browserTranscript.interimText}</span>
                        )}
                        {!browserTranscript.finalText && !browserTranscript.interimText && 'Listening...'}
                      </>
                    ) : (
                      /* AWS chunked backend fallback */
                      <>
                        {liveScribe.transcript || 'Transcribing...'}
                      </>
                    )
                  ) : (
                    /* When stopped: show backend transcript (used for note generation) */
                    liveScribe.transcript || (liveScribe.status === 'paused' ? 'Paused...' : '')
                  )}
                </pre>
                
                {/* Debug Line: Visible engine + WS URL during recording */}
                {liveScribe.status === 'recording' && (
                  <div className="flex flex-col gap-1 p-2 bg-slate-100 dark:bg-slate-800 rounded text-xs font-mono border border-slate-200 dark:border-slate-700">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-foreground">Engine:</span>
                      <span className={`px-1.5 py-0.5 rounded ${
                        actualEngine === 'deepgram' 
                          ? 'bg-green-200 text-green-800 dark:bg-green-800 dark:text-green-200' 
                          : actualEngine === 'browser'
                          ? 'bg-blue-200 text-blue-800 dark:bg-blue-800 dark:text-blue-200'
                          : 'bg-amber-200 text-amber-800 dark:bg-amber-800 dark:text-amber-200'
                      }`}>
                        {actualEngine === 'deepgram' ? 'Deepgram STT' : actualEngine === 'browser' ? 'Browser STT' : 'AWS Chunked'}
                      </span>
                      {actualEngine === 'deepgram' && (
                        <span className="text-green-600 dark:text-green-400">✓ Connected</span>
                      )}
                      {actualEngine === 'browser' && isStreamingAvailable && (
                        <span className="text-orange-600 dark:text-orange-400">⚠ Deepgram fallback</span>
                      )}
                    </div>
                    {isStreamingAvailable && (
                      <div className="text-muted-foreground truncate">
                        <span className="font-semibold">WS URL:</span> {deepgramRelayUrl}/dictate
                      </div>
                    )}
                    {!isStreamingAvailable && (
                      <div className="text-muted-foreground">
                        <span className="font-semibold">Note:</span> VITE_DEEPGRAM_RELAY_URL not configured
                      </div>
                    )}
                  </div>
                )}
                
                {/* Show backend transcript count when using browser display */}
                {liveScribe.status === 'recording' && actualEngine === 'browser' && liveScribe.transcript && (
                  <p className="text-xs text-muted-foreground">
                    Backend transcript: {liveScribe.transcript.length} chars
                  </p>
                )}
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
                  {preferences.liveDraftMode === 'B' && (
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
                disabled={isStartingBatch || !preferences.patientName.trim() || !preferences.patientGender} 
                variant="secondary"
                title={(!preferences.patientName.trim() || !preferences.patientGender) ? 'Patient Name and Gender required' : ''}
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
        <Card className="border rounded-lg shadow-sm">
          <CardContent className="p-8">
            {/* Patient Header */}
            {preferences.patientName && (
              <div className="mb-8">
                <h1 className="text-3xl font-bold mb-1">{preferences.patientName}</h1>
                {hasNote && (
                  <div className="flex items-center gap-3">
                    <p className="text-muted-foreground">
                      {currentNoteType === 'SOAP_4_FIELD' ? 'SOAP Note (4-field)' : 'SOAP Note (3-field)'}
                    </p>
                    <div className="flex gap-2">
                      <CopyButton 
                        text={currentMarkdown} 
                        label="Copy" 
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
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
              <div className="space-y-6">
                {/* Editable SOAP Cards - 4 Fields */}
                <div className="space-y-6">
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <h2 className="text-2xl font-bold">Subjective:</h2>
                      <SectionCopyButton text={currentSoap.subjective || ''} sectionName="Subjective" />
                    </div>
                    <RichSoapTextarea
                      id="soap-subjective"
                      value={currentSoap.subjective || ''}
                      onChange={(e) => editSoapField('subjective', e.target.value)}
                      placeholder="Not documented."
                      enableRichDisplay={true}
                      className="border-0 p-0 text-base leading-relaxed"
                    />
                  </div>
                  
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <h2 className="text-2xl font-bold">Objective:</h2>
                      <SectionCopyButton text={currentSoap.objective || ''} sectionName="Objective" />
                    </div>
                    <AutoResizeTextarea
                      id="soap-objective"
                      value={currentSoap.objective || ''}
                      onChange={(e) => editSoapField('objective', e.target.value)}
                      placeholder="Not documented."
                      className="border-0 p-0 text-base leading-relaxed"
                    />
                  </div>
                  
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <h2 className="text-2xl font-bold">Assessment:</h2>
                      <SectionCopyButton text={currentSoap.assessment || ''} sectionName="Assessment" />
                    </div>
                    <RichSoapTextarea
                      id="soap-assessment"
                      value={currentSoap.assessment || ''}
                      onChange={(e) => editSoapField('assessment', e.target.value)}
                      placeholder="Not documented."
                      enableRichDisplay={true}
                      className="border-0 p-0 text-base leading-relaxed"
                    />
                  </div>
                  
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <h2 className="text-2xl font-bold">Plan:</h2>
                      <SectionCopyButton text={currentSoap.plan || ''} sectionName="Plan" />
                    </div>
                    <RichSoapTextarea
                      id="soap-plan"
                      value={currentSoap.plan || ''}
                      onChange={(e) => editSoapField('plan', e.target.value)}
                      placeholder="Not documented."
                      enableRichDisplay={true}
                      className="border-0 p-0 text-base leading-relaxed"
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
              <div className="space-y-6">
                {/* Editable SOAP Cards - 3 Fields */}
                <div className="space-y-6">
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <h2 className="text-2xl font-bold">Subjective:</h2>
                      <SectionCopyButton text={currentSoap3.subjective || ''} sectionName="Subjective" />
                    </div>
                    <RichSoapTextarea
                      id="soap3-subjective"
                      value={currentSoap3.subjective || ''}
                      onChange={(e) => editSoap3Field('subjective', e.target.value)}
                      placeholder="Not documented."
                      enableRichDisplay={true}
                      className="border-0 p-0 text-base leading-relaxed"
                    />
                  </div>
                  
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <h2 className="text-2xl font-bold">Objective:</h2>
                      <SectionCopyButton text={currentSoap3.objective || ''} sectionName="Objective" />
                    </div>
                    <AutoResizeTextarea
                      id="soap3-objective"
                      value={currentSoap3.objective || ''}
                      onChange={(e) => editSoap3Field('objective', e.target.value)}
                      placeholder="Not documented."
                      className="border-0 p-0 text-base leading-relaxed"
                    />
                  </div>
                  
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <h2 className="text-2xl font-bold">Assessment and Plan:</h2>
                      <SectionCopyButton text={currentSoap3.assessmentPlan || ''} sectionName="Assessment & Plan" />
                    </div>
                    <RichSoapTextarea
                      id="soap3-assessmentPlan"
                      value={currentSoap3.assessmentPlan || ''}
                      onChange={(e) => editSoap3Field('assessmentPlan', e.target.value)}
                      placeholder="Not documented."
                      enableRichDisplay={true}
                      className="border-0 p-0 text-base leading-relaxed"
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
                <div className="flex items-center gap-3">
                  <CardTitle className="text-lg">Patient Instructions</CardTitle>
                  <button
                    onClick={handleOpenSignatureModal}
                    className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 underline-offset-2 hover:underline"
                  >
                    <Pencil className="h-3 w-3" />
                    {preferences.clinicianDisplayName ? 'Edit signature' : 'Set signature'}
                  </button>
                </div>
                <SectionCopyButton text={getPatientInstructions()} sectionName="Patient Instructions" />
              </div>
            </CardHeader>
            <CardContent>
              {signatureNeededMessage && !preferences.clinicianDisplayName && (
                <div className="mb-4 p-3 rounded-lg border border-amber-500 bg-amber-50 dark:bg-amber-950/20 text-sm text-amber-700 dark:text-amber-400 flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                  <span>Set signature name to generate Patient Instructions.</span>
                  <button
                    onClick={handleOpenSignatureModal}
                    className="ml-auto text-primary underline hover:no-underline text-sm"
                  >
                    Set now
                  </button>
                </div>
              )}
              <div className="border rounded-lg p-4 bg-card">
                <AutoResizeTextarea
                  id="patient-instructions"
                  value={getPatientInstructions()}
                  onChange={(e) => editPatientInstructions(e.target.value)}
                  placeholder="Patient instructions will be generated here. This is a plain-language letter summarizing the visit for the patient."
                  className="min-h-[120px]"
                />
              </div>
              {!getPatientInstructions() && !signatureNeededMessage && (
                <p className="text-xs text-muted-foreground mt-2">
                  Patient instructions will be generated when you click "Generate SOAP".
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {/* Signature Name Modal */}
        <Dialog open={showSignatureModal} onOpenChange={setShowSignatureModal}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Set your letter signature</DialogTitle>
              <DialogDescription>
                This name will appear at the end of Patient Instructions letters.
              </DialogDescription>
            </DialogHeader>
            <div className="py-4">
              <Label htmlFor="signature-name" className="text-sm font-medium">
                Signature name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="signature-name"
                value={pendingSignatureName}
                onChange={(e) => setPendingSignatureName(e.target.value)}
                placeholder="Dr. Jane Smith"
                className="mt-2"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleSaveSignature();
                  }
                }}
              />
            </div>
            <DialogFooter className="gap-2 sm:gap-0">
              <Button variant="outline" onClick={handleCancelSignature}>
                Cancel
              </Button>
              <Button onClick={handleSaveSignature} disabled={!pendingSignatureName.trim()}>
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* End Encounter Confirmation Dialog */}
        <AlertDialog open={showEndEncounterDialog} onOpenChange={setShowEndEncounterDialog}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Start a new encounter?</AlertDialogTitle>
              <AlertDialogDescription className="space-y-2">
                <span className="block">This will clear:</span>
                <ul className="list-disc list-inside text-sm space-y-1">
                  <li>Current transcript and running summary</li>
                  <li>Generated SOAP note and Patient Instructions</li>
                  <li>Patient name and gender</li>
                </ul>
                <span className="block text-destructive font-medium mt-2">
                  ⚠️ This action cannot be undone.
                </span>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleEndEncounter} className="bg-destructive hover:bg-destructive/90">
                End Encounter
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

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
