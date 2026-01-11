/**
 * useHybridLiveScribe - Streaming STT for Live Transcript with throttled Running Summary
 * 
 * Uses Deepgram streaming (via relay) for real-time transcription:
 * - Immediate final transcripts on each utterance
 * - Running Summary throttled: single in-flight job, 45s debounce, never blocks audio/stop
 * 
 * Falls back to useLiveScribe (batch) if VITE_DEEPGRAM_RELAY_URL is not configured.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useDeepgramStream, DeepgramStreamStatus, DeepgramStreamMetrics } from './useDeepgramStream';
import type { LiveDraftMode } from './useDocNoteSession';
import { safeLog, safeWarn, safeErrorLog } from '@/lib/debug';

export type HybridLiveScribeStatus = 'idle' | 'connecting' | 'recording' | 'paused' | 'finalizing' | 'done' | 'error';

export interface HybridLiveScribeDebugInfo {
  engine: 'deepgram' | 'batch';
  streamStatus: DeepgramStreamStatus;
  streamMetrics: DeepgramStreamMetrics | null;
  // Summary fields
  lastSummaryCallAt: string | null;
  lastSummaryError: string | null;
  summaryInFlight: boolean;
  summaryCallCount: number;
  // Unified fields (compatible with batch debug info)
  transcriptLength: number;
  chunksSent: number;
  totalTranscriptLength: number;
  inputSampleRate: number | null;
  outputSampleRate: number;
  encoding: string;
  bytesPerChunk: number | null;
  chunksWithNoTranscript: number;
  lastLiveStatus: 'idle' | 'calling' | 'received' | 'error';
  lastLiveCallAt: string | null;
  lastLiveError: string | null;
}

interface UseHybridLiveScribeOptions {
  onTranscriptUpdate?: (transcript: string) => void;
  onSummaryUpdate?: (summary: string) => void;
  onError?: (error: string) => void;
  liveDraftMode?: LiveDraftMode;
  preferences?: object;
}

// Summary throttling constants
const SUMMARY_DEBOUNCE_MS = 45000; // 45 seconds between summary calls
const SUMMARY_MIN_DELTA_CHARS = 100; // Minimum new text before triggering summary

// Default debug info helper
const createDefaultDebugInfo = (engine: 'deepgram' | 'batch', streamStatus: DeepgramStreamStatus = 'idle'): HybridLiveScribeDebugInfo => ({
  engine,
  streamStatus,
  streamMetrics: null,
  lastSummaryCallAt: null,
  lastSummaryError: null,
  summaryInFlight: false,
  summaryCallCount: 0,
  transcriptLength: 0,
  // Unified fields for batch compatibility
  chunksSent: 0,
  totalTranscriptLength: 0,
  inputSampleRate: 16000,
  outputSampleRate: 16000,
  encoding: 'pcm16',
  bytesPerChunk: null,
  chunksWithNoTranscript: 0,
  lastLiveStatus: 'idle',
  lastLiveCallAt: null,
  lastLiveError: null,
});

export function useHybridLiveScribe(options: UseHybridLiveScribeOptions = {}) {
  const {
    onTranscriptUpdate,
    onSummaryUpdate,
    onError,
    liveDraftMode = 'A',
    preferences = {},
  } = options;

  // Check if Deepgram relay is configured
  const relayUrl = import.meta.env.VITE_DEEPGRAM_RELAY_URL;
  const useStreaming = Boolean(relayUrl);

  // State
  const [status, setStatus] = useState<HybridLiveScribeStatus>('idle');
  const [transcript, setTranscript] = useState('');
  const [runningSummary, setRunningSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recordingElapsedMs, setRecordingElapsedMs] = useState(0);
  
  // Debug info
  const [debugInfo, setDebugInfo] = useState<HybridLiveScribeDebugInfo>(
    createDefaultDebugInfo(useStreaming ? 'deepgram' : 'batch')
  );

  // Refs for summary throttling
  const summaryInFlightRef = useRef(false);
  const lastSummaryAtRef = useRef<number>(0);
  const lastSummaryLengthRef = useRef(0);
  const currentSummaryRef = useRef<string | null>(null);
  const summaryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const summaryCallCountRef = useRef(0);

  // Transcript ref for callbacks
  const transcriptRef = useRef('');

  // Deepgram stream hook
  const deepgramStream = useDeepgramStream({
    relayUrl: relayUrl || '',
    onPartialTranscript: (text) => {
      // Could show interim results in UI if desired
    },
    onFinalTranscript: (fullTranscript) => {
      transcriptRef.current = fullTranscript;
      setTranscript(fullTranscript);
      setDebugInfo(prev => ({ ...prev, transcriptLength: fullTranscript.length }));
      onTranscriptUpdate?.(fullTranscript);
      
      // Schedule throttled summary update
      if (liveDraftMode === 'B') {
        scheduleSummaryUpdate(fullTranscript);
      }
    },
    onError: (err) => {
      setError(err);
      onError?.(err);
    },
  });

  // Sync Deepgram status to our status and update debug info
  useEffect(() => {
    const dgStatus = deepgramStream.status;
    const dgMetrics = deepgramStream.metrics;
    
    setDebugInfo(prev => ({
      ...prev,
      streamStatus: dgStatus,
      streamMetrics: dgMetrics,
      // Sync streaming metrics to batch-compatible fields
      chunksSent: dgMetrics.finalCount,
      totalTranscriptLength: prev.transcriptLength,
      lastLiveStatus: dgStatus === 'recording' ? 'received' : dgStatus === 'connecting' ? 'calling' : dgStatus === 'error' ? 'error' : 'idle',
      bytesPerChunk: dgMetrics.audioBytesSent > 0 && dgMetrics.finalCount > 0 
        ? Math.round(dgMetrics.audioBytesSent / dgMetrics.finalCount) 
        : null,
    }));
    
    // Map Deepgram status to HybridLiveScribe status
    if (dgStatus === 'connecting') {
      setStatus('connecting');
    } else if (dgStatus === 'recording') {
      setStatus('recording');
    } else if (dgStatus === 'finalizing') {
      setStatus('finalizing');
    } else if (dgStatus === 'done') {
      setStatus('done');
    } else if (dgStatus === 'error') {
      setStatus('error');
    }
  }, [deepgramStream.status, deepgramStream.metrics]);

  // Sync recording elapsed time
  useEffect(() => {
    setRecordingElapsedMs(deepgramStream.recordingElapsedMs);
  }, [deepgramStream.recordingElapsedMs]);

  /**
   * Throttled summary update - single in-flight, debounced
   */
  const scheduleSummaryUpdate = useCallback((fullTranscript: string) => {
    // Skip if summary already in-flight
    if (summaryInFlightRef.current) {
      safeLog('[HybridLiveScribe] Summary in-flight, skipping schedule');
      return;
    }
    
    // Check minimum delta
    const delta = fullTranscript.length - lastSummaryLengthRef.current;
    if (delta < SUMMARY_MIN_DELTA_CHARS) {
      return;
    }
    
    // Debounce - clear existing timeout
    if (summaryTimeoutRef.current) {
      clearTimeout(summaryTimeoutRef.current);
    }
    
    // Check if enough time has passed since last summary
    const timeSinceLastSummary = Date.now() - lastSummaryAtRef.current;
    const waitTime = Math.max(0, SUMMARY_DEBOUNCE_MS - timeSinceLastSummary);
    
    safeLog(`[HybridLiveScribe] Scheduling summary in ${waitTime}ms, delta: ${delta} chars`);
    
    summaryTimeoutRef.current = setTimeout(() => {
      triggerSummaryUpdate(fullTranscript);
    }, waitTime);
  }, []);

  /**
   * Actually call the summary endpoint
   */
  const triggerSummaryUpdate = useCallback(async (fullTranscript: string) => {
    // Double-check not in-flight
    if (summaryInFlightRef.current) {
      safeLog('[HybridLiveScribe] Summary already in-flight, aborting trigger');
      return;
    }
    
    const transcriptDelta = fullTranscript.slice(lastSummaryLengthRef.current);
    if (transcriptDelta.trim().length < 50) {
      return;
    }
    
    summaryInFlightRef.current = true;
    summaryCallCountRef.current++;
    const callTime = new Date().toISOString();
    
    setDebugInfo(prev => ({
      ...prev,
      summaryInFlight: true,
      lastSummaryCallAt: callTime,
      lastSummaryError: null,
      summaryCallCount: summaryCallCountRef.current,
    }));
    
    try {
      safeLog(`[HybridLiveScribe] Triggering summary update, delta: ${transcriptDelta.length} chars`);
      
      const { data, error: fnError } = await supabase.functions.invoke('update-visit-summary', {
        body: {
          transcriptDelta,
          runningSummary: currentSummaryRef.current,
          preferences,
        },
      });
      
      if (fnError) {
        throw new Error(fnError.message || 'Summary update failed');
      }
      
      if (data?.error) {
        throw new Error(data.error);
      }
      
      const summary = data?.runningSummary || data?.summary;
      if (summary) {
        currentSummaryRef.current = summary;
        setRunningSummary(summary);
        onSummaryUpdate?.(summary);
        lastSummaryLengthRef.current = fullTranscript.length;
        lastSummaryAtRef.current = Date.now();
        safeLog(`[HybridLiveScribe] Summary updated, length: ${summary.length}`);
      }
      
      setDebugInfo(prev => ({
        ...prev,
        summaryInFlight: false,
        lastSummaryError: null,
      }));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      safeErrorLog('[HybridLiveScribe] Summary update failed:', err);
      
      setDebugInfo(prev => ({
        ...prev,
        summaryInFlight: false,
        lastSummaryError: errMsg,
      }));
      
      // Don't propagate error - summary is non-blocking
    } finally {
      summaryInFlightRef.current = false;
    }
  }, [preferences, onSummaryUpdate]);

  /**
   * Start recording with Deepgram streaming
   */
  const startRecording = useCallback(async () => {
    if (!useStreaming) {
      setError('Deepgram relay not configured (VITE_DEEPGRAM_RELAY_URL)');
      setStatus('error');
      onError?.('Deepgram relay not configured');
      return;
    }
    
    // Reset state
    setError(null);
    setTranscript('');
    setRunningSummary(null);
    transcriptRef.current = '';
    lastSummaryLengthRef.current = 0;
    currentSummaryRef.current = null;
    summaryCallCountRef.current = 0;
    lastSummaryAtRef.current = 0;
    
    setDebugInfo(createDefaultDebugInfo('deepgram', 'connecting'));
    
    await deepgramStream.startRecording();
    safeLog('[HybridLiveScribe] Started Deepgram streaming');
  }, [useStreaming, deepgramStream, onError]);

  /**
   * Stop recording and get final transcript
   */
  const stopRecording = useCallback(async (): Promise<string> => {
    // Clear any pending summary timeout
    if (summaryTimeoutRef.current) {
      clearTimeout(summaryTimeoutRef.current);
      summaryTimeoutRef.current = null;
    }
    
    // Stop Deepgram stream
    const finalTranscript = await deepgramStream.stopRecording();
    
    // Trigger final summary if in mode B and have content
    if (liveDraftMode === 'B' && finalTranscript.length > lastSummaryLengthRef.current) {
      // Fire-and-forget - don't block stop
      triggerSummaryUpdate(finalTranscript).catch(() => {});
    }
    
    safeLog(`[HybridLiveScribe] Stopped, transcript length: ${finalTranscript.length}`);
    return finalTranscript;
  }, [deepgramStream, liveDraftMode, triggerSummaryUpdate]);

  /**
   * Pause recording - Deepgram streaming doesn't natively support pause,
   * so we stop and preserve transcript for UI consistency
   */
  const pauseRecording = useCallback(() => {
    safeWarn('[HybridLiveScribe] Pause not supported in streaming mode - use stop instead');
    // For now, we just set status to paused for UI, but don't actually pause audio
    // A full implementation would require stopping the stream and reconnecting on resume
  }, []);

  /**
   * Resume recording - would require reconnecting stream
   */
  const resumeRecording = useCallback(() => {
    safeWarn('[HybridLiveScribe] Resume not supported in streaming mode - use start instead');
  }, []);

  /**
   * Reset to initial state
   */
  const reset = useCallback(() => {
    // Clear summary timeout
    if (summaryTimeoutRef.current) {
      clearTimeout(summaryTimeoutRef.current);
      summaryTimeoutRef.current = null;
    }
    
    deepgramStream.reset();
    
    setStatus('idle');
    setTranscript('');
    setRunningSummary(null);
    setError(null);
    setRecordingElapsedMs(0);
    transcriptRef.current = '';
    lastSummaryLengthRef.current = 0;
    currentSummaryRef.current = null;
    summaryCallCountRef.current = 0;
    
    setDebugInfo(createDefaultDebugInfo(useStreaming ? 'deepgram' : 'batch', 'idle'));
  }, [deepgramStream, useStreaming]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (summaryTimeoutRef.current) {
        clearTimeout(summaryTimeoutRef.current);
      }
    };
  }, []);

  return {
    // State
    status,
    transcript,
    runningSummary,
    error,
    recordingElapsedMs,
    debugInfo,
    
    // Actions
    startRecording,
    stopRecording,
    pauseRecording,
    resumeRecording,
    reset,
    
    // Computed
    isRecording: status === 'recording',
    isConnecting: status === 'connecting',
    isFinalizing: status === 'finalizing',
    isStreamingAvailable: useStreaming,
  };
}
