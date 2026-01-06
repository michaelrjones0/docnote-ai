import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, LogOut, ShieldCheck, Play, FileText, Copy, Check } from 'lucide-react';

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
  const [jobName, setJobName] = useState('');
  const [startBatchResult, setStartBatchResult] = useState<string | null>(null);
  const [isStartingBatch, setIsStartingBatch] = useState(false);
  const [soapResult, setSoapResult] = useState<SoapResponse | null>(null);
  const [isGeneratingSoap, setIsGeneratingSoap] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);

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
    const jobNameToUse = overrideJobName ?? jobName;
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

  const getTranscriptFromBatchStatus = (): string => {
    if (!batchStatusResult) return '';
    try {
      const parsed = JSON.parse(batchStatusResult);
      // Check both direct .text and nested .result.text
      const text = (parsed?.text ?? parsed?.result?.text) ?? '';
      return typeof text === 'string' ? text.trim() : '';
    } catch {
      return '';
    }
  };

  const handleGenerateSoap = async () => {
    const transcript = getTranscriptFromBatchStatus();
    if (!transcript) {
      toast({
        title: 'No transcript available',
        description: 'Please run "Test Batch Status" first to get a completed transcript.',
        variant: 'destructive',
      });
      return;
    }

    setIsGeneratingSoap(true);
    setSoapResult(null);

    try {
      const { data, error } = await supabase.functions.invoke('generate-note', {
        body: { 
          noteType: 'SOAP',
          transcript 
        }
      });

      if (error) {
        setSoapResult({ error: error.message } as SoapResponse);
      } else {
        setSoapResult(data as SoapResponse);
      }
    } catch (err) {
      setSoapResult({ error: String(err) } as SoapResponse);
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
    >
      {copiedField === label ? (
        <Check className="h-3 w-3" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
      {label}
    </Button>
  );

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

  const transcript = getTranscriptFromBatchStatus();

  return (
    <div className="min-h-screen bg-background p-4">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-xl">DocNoteAI</CardTitle>
              <div className="flex items-center gap-4">
                <span className="text-sm text-muted-foreground">{user.email}</span>
                <Button onClick={handleLogout} variant="outline" size="sm">
                  <LogOut className="h-4 w-4 mr-2" />
                  Log Out
                </Button>
              </div>
            </div>
          </CardHeader>
        </Card>

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
                  value={jobName}
                  onChange={(e) => setJobName(e.target.value)}
                  className="font-mono"
                />
              </div>
              <Button 
                onClick={() => handleTestBatchStatus()} 
                disabled={isTestingBatchStatus || !jobName.trim()}
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

            <Button 
              onClick={handleGenerateSoap} 
              disabled={isGeneratingSoap || !transcript} 
              className="w-full"
              variant="default"
            >
              {isGeneratingSoap ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <FileText className="h-4 w-4 mr-2" />
              )}
              {!transcript ? 'No transcript available' : 'Generate SOAP'}
            </Button>
          </CardContent>
        </Card>

        {/* Transcript Section */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">Transcript</CardTitle>
              {transcript && (
                <CopyButton text={transcript} label="Copy Transcript" />
              )}
            </div>
          </CardHeader>
          <CardContent>
            {transcript ? (
              <pre className="bg-muted p-4 rounded-md text-sm overflow-auto max-h-64 whitespace-pre-wrap font-mono border">
                {transcript}
              </pre>
            ) : (
              <div className="bg-muted/50 p-4 rounded-md text-center text-muted-foreground">
                No transcript loaded yet. Run "Start Batch" and "Test Batch Status" first.
              </div>
            )}
          </CardContent>
        </Card>

        {/* SOAP Note Section */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">SOAP Note</CardTitle>
              {soapResult && !soapResult.error && (
                <div className="flex gap-2">
                  <CopyButton 
                    text={soapResult.markdown || soapResult.note || ''} 
                    label="Copy SOAP" 
                  />
                  <CopyButton 
                    text={JSON.stringify(soapResult, null, 2)} 
                    label="Copy JSON" 
                  />
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {soapResult?.error ? (
              <div className="bg-destructive/10 border border-destructive/20 p-4 rounded-md text-destructive">
                Error: {soapResult.error}
              </div>
            ) : soapResult?.soap ? (
              <div className="space-y-4">
                {/* Structured SOAP Cards */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="border rounded-lg p-4 bg-card">
                    <h4 className="font-semibold text-sm text-primary mb-2 uppercase tracking-wide">Subjective</h4>
                    <p className="text-sm whitespace-pre-wrap">
                      {soapResult.soap.subjective || 'Not documented.'}
                    </p>
                  </div>
                  
                  <div className="border rounded-lg p-4 bg-card">
                    <h4 className="font-semibold text-sm text-primary mb-2 uppercase tracking-wide">Objective</h4>
                    <p className="text-sm whitespace-pre-wrap">
                      {soapResult.soap.objective || 'Not documented.'}
                    </p>
                  </div>
                  
                  <div className="border rounded-lg p-4 bg-card">
                    <h4 className="font-semibold text-sm text-primary mb-2 uppercase tracking-wide">Assessment</h4>
                    <p className="text-sm whitespace-pre-wrap">
                      {soapResult.soap.assessment || 'Not documented.'}
                    </p>
                  </div>
                  
                  <div className="border rounded-lg p-4 bg-card">
                    <h4 className="font-semibold text-sm text-primary mb-2 uppercase tracking-wide">Plan</h4>
                    <p className="text-sm whitespace-pre-wrap">
                      {soapResult.soap.plan || 'Not documented.'}
                    </p>
                  </div>
                </div>

                {/* Markdown Preview */}
                <details className="text-sm">
                  <summary className="cursor-pointer text-muted-foreground hover:text-foreground font-medium">
                    View Formatted Markdown
                  </summary>
                  <pre className="mt-3 bg-muted p-4 rounded-md overflow-auto max-h-64 whitespace-pre-wrap font-mono border">
                    {soapResult.markdown || soapResult.note}
                  </pre>
                </details>
              </div>
            ) : (
              <div className="bg-muted/50 p-4 rounded-md text-center text-muted-foreground">
                No SOAP note generated yet. Click "Generate SOAP" after loading a transcript.
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default AppHome;
