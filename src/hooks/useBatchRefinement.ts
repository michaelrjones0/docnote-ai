/**
 * useBatchRefinement - Async batch transcription refinement with optimized polling.
 * 
 * Features:
 * - Non-blocking: doesn't hold up SOAP generation from draft
 * - Single poll loop with exponential backoff (5s → 15s)
 * - 10-minute timeout
 * - PHI-safe logging (only timing/status metadata)
 * 
 * Usage:
 * 1. Call startBatchJob(audioBlob) after recording stops
 * 2. Poll happens automatically in background
 * 3. When ready, refinedTranscript is populated and isRefinedReady=true
 * 4. UI shows "Regenerate Note" option
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { safeLog, safeWarn, safeErrorLog } from '@/lib/debug';

export type BatchStatus = 'idle' | 'uploading' | 'processing' | 'completed' | 'failed' | 'timeout';

interface BatchJobState {
  jobName: string | null;
  status: BatchStatus;
  refinedTranscript: string | null;
  error: string | null;
  startedAt: number | null;
  completedAt: number | null;
}

interface UseBatchRefinementOptions {
  onRefinedReady?: (transcript: string) => void;
  onError?: (error: string) => void;
}

// Polling config
const INITIAL_POLL_INTERVAL_MS = 5000;  // Start at 5s
const MAX_POLL_INTERVAL_MS = 15000;     // Max 15s
const POLL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minute timeout

export function useBatchRefinement(options: UseBatchRefinementOptions = {}) {
  const { onRefinedReady, onError } = options;

  const [state, setState] = useState<BatchJobState>({
    jobName: null,
    status: 'idle',
    refinedTranscript: null,
    error: null,
    startedAt: null,
    completedAt: null,
  });

  const pollIntervalRef = useRef<number>(INITIAL_POLL_INTERVAL_MS);
  const pollTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isPollingRef = useRef(false);
  const abortRef = useRef(false);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortRef.current = true;
      if (pollTimeoutRef.current) {
        clearTimeout(pollTimeoutRef.current);
      }
    };
  }, []);

  // Start batch transcription job
  const startBatchJob = useCallback(async (audioBlob: Blob): Promise<string | null> => {
    if (audioBlob.size < 20 * 1024) {
      safeLog('[BatchRefinement] Audio too small, skipping batch job. Size:', audioBlob.size);
      return null;
    }

    const startedAt = Date.now();
    
    setState({
      jobName: null,
      status: 'uploading',
      refinedTranscript: null,
      error: null,
      startedAt,
      completedAt: null,
    });

    try {
      // Convert blob to base64
      const arrayBuffer = await audioBlob.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);
      let binary = '';
      const chunkSize = 0x8000;
      for (let i = 0; i < uint8Array.length; i += chunkSize) {
        const chunk = uint8Array.subarray(i, Math.min(i + chunkSize, uint8Array.length));
        binary += String.fromCharCode.apply(null, Array.from(chunk));
      }
      const base64Audio = btoa(binary);

      safeLog('[BatchRefinement] Starting batch job, audio size:', audioBlob.size);

      const { data, error } = await supabase.functions.invoke('start-batch-audio', {
        body: {
          audio: base64Audio,
          mimeType: audioBlob.type || 'audio/wav',
        },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      const jobName = data?.jobName;
      if (!jobName) throw new Error('No job name returned');

      safeLog('[BatchRefinement] Job started:', jobName);

      setState(prev => ({
        ...prev,
        jobName,
        status: 'processing',
      }));

      // Start polling
      abortRef.current = false;
      pollIntervalRef.current = INITIAL_POLL_INTERVAL_MS;
      isPollingRef.current = true;
      schedulePoll(jobName, startedAt);

      return jobName;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Failed to start batch job';
      safeErrorLog('[BatchRefinement] Start failed:', err);
      
      setState(prev => ({
        ...prev,
        status: 'failed',
        error: errMsg,
      }));
      
      onError?.(errMsg);
      return null;
    }
  }, [onError]);

  // Schedule next poll with exponential backoff
  const schedulePoll = useCallback((jobName: string, jobStartedAt: number) => {
    if (abortRef.current || !isPollingRef.current) return;

    // Check timeout
    if (Date.now() - jobStartedAt > POLL_TIMEOUT_MS) {
      safeWarn('[BatchRefinement] Polling timeout after 10 minutes');
      setState(prev => ({
        ...prev,
        status: 'timeout',
        error: 'Batch processing timed out',
      }));
      isPollingRef.current = false;
      onError?.('Batch processing timed out');
      return;
    }

    pollTimeoutRef.current = setTimeout(async () => {
      await pollStatus(jobName, jobStartedAt);
    }, pollIntervalRef.current);

    // Increase interval for next poll (exponential backoff capped at max)
    pollIntervalRef.current = Math.min(
      pollIntervalRef.current * 1.5,
      MAX_POLL_INTERVAL_MS
    );
  }, [onError]);

  // Poll for job status
  const pollStatus = useCallback(async (jobName: string, jobStartedAt: number) => {
    if (abortRef.current || !isPollingRef.current) return;

    try {
      safeLog('[BatchRefinement] Polling status, interval:', pollIntervalRef.current);

      const { data, error } = await supabase.functions.invoke('transcribe-audio-batch-status', {
        body: { jobName },
      });

      if (error) throw error;

      const status = data?.status;
      safeLog('[BatchRefinement] Poll result:', status);

      if (status === 'COMPLETED') {
        const transcript = data?.transcript || data?.text || '';
        const completedAt = Date.now();
        
        safeLog('[BatchRefinement] Completed, transcript length:', transcript.length);
        
        setState(prev => ({
          ...prev,
          status: 'completed',
          refinedTranscript: transcript,
          completedAt,
        }));
        
        isPollingRef.current = false;
        onRefinedReady?.(transcript);
        return;
      }

      if (status === 'FAILED' || status === 'NOT_FOUND') {
        const errMsg = data?.failureReason || 'Batch job failed';
        safeErrorLog('[BatchRefinement] Job failed:', errMsg);
        
        setState(prev => ({
          ...prev,
          status: 'failed',
          error: errMsg,
        }));
        
        isPollingRef.current = false;
        onError?.(errMsg);
        return;
      }

      // Still processing - schedule next poll
      schedulePoll(jobName, jobStartedAt);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Poll failed';
      safeErrorLog('[BatchRefinement] Poll error:', err);
      
      // Don't fail on transient errors - just schedule next poll
      safeWarn('[BatchRefinement] Transient poll error, retrying...');
      schedulePoll(jobName, jobStartedAt);
    }
  }, [schedulePoll, onRefinedReady, onError]);

  // Cancel polling
  const cancelPolling = useCallback(() => {
    safeLog('[BatchRefinement] Cancelling polling');
    abortRef.current = true;
    isPollingRef.current = false;
    if (pollTimeoutRef.current) {
      clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }
  }, []);

  // Reset state
  const reset = useCallback(() => {
    cancelPolling();
    setState({
      jobName: null,
      status: 'idle',
      refinedTranscript: null,
      error: null,
      startedAt: null,
      completedAt: null,
    });
  }, [cancelPolling]);

  // Computed values
  const isRefinedReady = state.status === 'completed' && !!state.refinedTranscript;
  const isProcessing = state.status === 'uploading' || state.status === 'processing';
  const processingTimeMs = state.startedAt && state.completedAt 
    ? state.completedAt - state.startedAt 
    : null;

  return {
    ...state,
    isRefinedReady,
    isProcessing,
    processingTimeMs,
    startBatchJob,
    cancelPolling,
    reset,
  };
}
