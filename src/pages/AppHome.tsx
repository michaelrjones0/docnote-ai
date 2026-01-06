import { useEffect, useState } from 'react';
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
import { Loader2, LogOut, ShieldCheck, Play, FileText, Copy, Check, RefreshCw, Trash2, AlertTriangle, Settings } from 'lucide-react';
import { useDocNoteSession } from '@/hooks/useDocNoteSession';
import { usePhysicianPreferences } from '@/hooks/usePhysicianPreferences';
import { DemoModeGuard, DemoModeBanner, ResetDemoAckButton } from '@/components/DemoModeGuard';

interface SoapData {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
}

interface SoapResponse {
  noteType: string;
  note: string;
  markdown: string;
  soap: SoapData;
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

  const {
    session: docSession,
    showConflictBanner,
    setJobName,
    setTranscriptText,
    setMarkdownExpanded,
    handleNewGenerated,
    acceptNewGenerated,
    keepUserEdits,
    editSoapField,
    syncMarkdownFromSoap,
    clearSession,
    getCurrentSoap,
    getCurrentMarkdown,
    getExportJson,
  } = useDocNoteSession();

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

  const handleGenerateSoap = async () => {
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

    try {
      const { data, error } = await supabase.functions.invoke('generate-note', {
        body: { 
          noteType: 'SOAP',
          transcript,
          preferences
        }
      });

      if (error) {
        toast({
          title: 'Generation failed',
          description: error.message,
          variant: 'destructive',
        });
      } else if (data?.soap) {
        handleNewGenerated({
          noteType: data.noteType || 'SOAP',
          soap: data.soap,
          markdown: data.markdown || data.note || '',
        });
        toast({
          title: 'SOAP note generated',
          description: 'Your note has been generated successfully.',
        });
      }
    } catch (err) {
      toast({
        title: 'Generation failed',
        description: String(err),
        variant: 'destructive',
      });
    } finally {
      setIsGeneratingSoap(false);
    }
  };

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
  const currentMarkdown = getCurrentMarkdown();
  const exportJson = getExportJson();

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

        {/* Conflict Banner */}
        {showConflictBanner && (
          <Card className="border-amber-500 bg-amber-50 dark:bg-amber-950/20">
            <CardContent className="py-4">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <AlertTriangle className="h-5 w-5 text-amber-600" />
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
            </CardContent>
          </Card>
        )}

        {/* Controls */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Transcription Controls</CardTitle>
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
              </div>
            </div>

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
          </CardContent>
        </Card>

        {/* SOAP Note Section */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">SOAP Note</CardTitle>
              {currentSoap && (
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
            {currentSoap ? (
              <div className="space-y-4">
                {/* Editable SOAP Cards - Vertical Stack */}
                <div className="space-y-4">
                  <div className="border rounded-lg p-4 bg-card">
                    <Label htmlFor="soap-subjective" className="font-semibold text-sm text-primary mb-2 uppercase tracking-wide block">
                      Subjective
                    </Label>
                    <AutoResizeTextarea
                      id="soap-subjective"
                      value={currentSoap.subjective || ''}
                      onChange={(e) => editSoapField('subjective', e.target.value)}
                      placeholder="Not documented."
                    />
                  </div>
                  
                  <div className="border rounded-lg p-4 bg-card">
                    <Label htmlFor="soap-objective" className="font-semibold text-sm text-primary mb-2 uppercase tracking-wide block">
                      Objective
                    </Label>
                    <AutoResizeTextarea
                      id="soap-objective"
                      value={currentSoap.objective || ''}
                      onChange={(e) => editSoapField('objective', e.target.value)}
                      placeholder="Not documented."
                    />
                  </div>
                  
                  <div className="border rounded-lg p-4 bg-card">
                    <Label htmlFor="soap-assessment" className="font-semibold text-sm text-primary mb-2 uppercase tracking-wide block">
                      Assessment
                    </Label>
                    <AutoResizeTextarea
                      id="soap-assessment"
                      value={currentSoap.assessment || ''}
                      onChange={(e) => editSoapField('assessment', e.target.value)}
                      placeholder="Not documented."
                    />
                  </div>
                  
                  <div className="border rounded-lg p-4 bg-card">
                    <Label htmlFor="soap-plan" className="font-semibold text-sm text-primary mb-2 uppercase tracking-wide block">
                      Plan
                    </Label>
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
                      Sync Markdown from SOAP
                    </Button>
                  </div>
                  {docSession.markdownExpanded && (
                    <pre className="bg-muted p-4 rounded-md overflow-auto max-h-64 whitespace-pre-wrap font-mono border text-sm">
                      {currentMarkdown || 'No markdown available.'}
                    </pre>
                  )}
                </div>
              </div>
            ) : (
              <div className="bg-muted/50 p-4 rounded-md text-center text-muted-foreground">
                No SOAP note generated yet. Click "Generate SOAP" after loading a transcript.
              </div>
            )}
          </CardContent>
        </Card>

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
                No transcript loaded yet. Run "Start Batch" and "Test Batch Status" first.
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
