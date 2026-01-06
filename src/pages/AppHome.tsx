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

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">You're logged in!</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6 text-center">
          <p className="text-muted-foreground">
            Signed in as: <span className="font-medium text-foreground">{user.email}</span>
          </p>
          
          <div className="space-y-3">
            <Button onClick={handleTestAuth} disabled={isTestingAuth} className="w-full">
              {isTestingAuth ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <ShieldCheck className="h-4 w-4 mr-2" />
              )}
              Test Auth
            </Button>
            
            {authCheckResult && (
              <pre className="text-left bg-muted p-3 rounded-md text-sm overflow-auto max-h-40">
                {authCheckResult}
              </pre>
            )}

            <Button 
              onClick={handleStartBatchLatest} 
              disabled={isStartingBatch} 
              className="w-full"
              variant="secondary"
            >
              {isStartingBatch ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Play className="h-4 w-4 mr-2" />
              )}
              Start Batch (Latest Audio)
            </Button>
            
            {startBatchResult && (
              <pre className="text-left bg-muted p-3 rounded-md text-sm overflow-auto max-h-40">
                {startBatchResult}
              </pre>
            )}

            <div className="space-y-2">
              <Label htmlFor="jobName">jobName</Label>
              <Input
                id="jobName"
                placeholder="Enter jobName..."
                value={jobName}
                onChange={(e) => setJobName(e.target.value)}
              />
            </div>

            <Button 
              onClick={() => handleTestBatchStatus()} 
              disabled={isTestingBatchStatus || !jobName.trim()} 
              className="w-full"
            >
              {isTestingBatchStatus ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <ShieldCheck className="h-4 w-4 mr-2" />
              )}
              {!jobName.trim() ? 'Please enter jobName' : 'Test Batch Status'}
            </Button>
            
            {batchStatusResult && (
              <pre className="text-left bg-muted p-3 rounded-md text-sm overflow-auto max-h-40">
                {batchStatusResult}
              </pre>
            )}

            <Button 
              onClick={handleGenerateSoap} 
              disabled={isGeneratingSoap || !getTranscriptFromBatchStatus()} 
              className="w-full"
              variant="default"
            >
              {isGeneratingSoap ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <FileText className="h-4 w-4 mr-2" />
              )}
              {!getTranscriptFromBatchStatus() ? 'No transcript available' : 'Generate SOAP'}
            </Button>
            
            {soapResult && (
              <div className="text-left space-y-4">
                {soapResult.error ? (
                  <div className="bg-destructive/10 border border-destructive/20 p-3 rounded-md text-sm text-destructive">
                    Error: {soapResult.error}
                  </div>
                ) : (
                  <>
                    {/* Transcript Section */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <h4 className="font-semibold text-sm">Transcript</h4>
                        <CopyButton text={getTranscriptFromBatchStatus()} label="Copy Transcript" />
                      </div>
                      <pre className="bg-muted p-3 rounded-md text-sm overflow-auto max-h-32 whitespace-pre-wrap">
                        {getTranscriptFromBatchStatus()}
                      </pre>
                    </div>

                    {/* SOAP Sections */}
                    {soapResult.soap && (
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <h4 className="font-semibold text-sm">SOAP Note</h4>
                          <div className="flex gap-2">
                            <CopyButton text={soapResult.markdown} label="Copy SOAP (Markdown)" />
                            <CopyButton text={JSON.stringify(soapResult, null, 2)} label="Copy JSON" />
                          </div>
                        </div>
                        
                        <div className="space-y-2">
                          <div className="bg-muted/50 p-3 rounded-md">
                            <h5 className="font-medium text-xs text-muted-foreground mb-1">SUBJECTIVE</h5>
                            <p className="text-sm whitespace-pre-wrap">{soapResult.soap.subjective}</p>
                          </div>
                          
                          <div className="bg-muted/50 p-3 rounded-md">
                            <h5 className="font-medium text-xs text-muted-foreground mb-1">OBJECTIVE</h5>
                            <p className="text-sm whitespace-pre-wrap">{soapResult.soap.objective}</p>
                          </div>
                          
                          <div className="bg-muted/50 p-3 rounded-md">
                            <h5 className="font-medium text-xs text-muted-foreground mb-1">ASSESSMENT</h5>
                            <p className="text-sm whitespace-pre-wrap">{soapResult.soap.assessment}</p>
                          </div>
                          
                          <div className="bg-muted/50 p-3 rounded-md">
                            <h5 className="font-medium text-xs text-muted-foreground mb-1">PLAN</h5>
                            <p className="text-sm whitespace-pre-wrap">{soapResult.soap.plan}</p>
                          </div>
                        </div>

                        {/* Markdown Preview */}
                        <details className="text-sm">
                          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                            View Raw Markdown
                          </summary>
                          <pre className="mt-2 bg-muted p-3 rounded-md overflow-auto max-h-40 whitespace-pre-wrap">
                            {soapResult.markdown}
                          </pre>
                        </details>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          <Button onClick={handleLogout} variant="outline" className="w-full">
            <LogOut className="h-4 w-4 mr-2" />
            Log Out
          </Button>
        </CardContent>
      </Card>
    </div>
  );
};

export default AppHome;
