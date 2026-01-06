import { useState, useRef, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { LiveDraftMode } from './useDocNoteSession';

export type LiveScribeStatus = 'idle' | 'recording' | 'finalizing' | 'done' | 'error';

interface TranscriptSegment {
  content: string;
  speaker: string;
  startMs: number;
  endMs: number;
}

export interface LiveScribeDebugInfo {
  lastLiveCallAt: string | null;
  lastLiveStatus: 'idle' | 'calling' | 'received' | 'error';
  lastLiveError: string | null;
  lastSummaryCallAt: string | null;
  lastSummaryError: string | null;
  chunksSent: number;
  totalTranscriptLength: number;
}

interface UseLiveScribeOptions {
  onTranscriptUpdate?: (transcript: string, segments: TranscriptSegment[]) => void;
  onSummaryUpdate?: (summary: string) => void;
  onError?: (error: string) => void;
  chunkIntervalMs?: number;
  liveDraftMode?: LiveDraftMode;
  preferences?: object;
}

export function useLiveScribe(options: UseLiveScribeOptions = {}) {
  const { 
    onTranscriptUpdate, 
    onSummaryUpdate,
    onError, 
    chunkIntervalMs = 10000,
    liveDraftMode = 'A',
    preferences = {}
  } = options;
  
  const [status, setStatus] = useState<LiveScribeStatus>('idle');
  const [transcript, setTranscript] = useState('');
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [runningSummary, setRunningSummary] = useState<string | null>(null);
  
  // Debug state
  const [debugInfo, setDebugInfo] = useState<LiveScribeDebugInfo>({
    lastLiveCallAt: null,
    lastLiveStatus: 'idle',
    lastLiveError: null,
    lastSummaryCallAt: null,
    lastSummaryError: null,
    chunksSent: 0,
    totalTranscriptLength: 0,
  });

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const chunkIndexRef = useRef(0);
  const isProcessingRef = useRef(false);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  
  // Accumulated transcript for proper delta calculation
  const accumulatedTranscriptRef = useRef('');
  
  // For running summary (Option B)
  const lastSummaryTranscriptLengthRef = useRef(0);
  const summaryIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const currentRunningSummaryRef = useRef<string | null>(null);

  const processAudioChunk = useCallback(async (audioBlob: Blob, chunkIndex: number) => {
    const callTime = new Date().toISOString();
    setDebugInfo(prev => ({
      ...prev,
      lastLiveCallAt: callTime,
      lastLiveStatus: 'calling',
      lastLiveError: null,
      chunksSent: prev.chunksSent + 1,
    }));
    
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

      console.log(`[LiveScribe] Processing chunk ${chunkIndex}, size: ${audioBlob.size} bytes`);

      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      
      if (!accessToken) {
        throw new Error('No access token available');
      }

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/transcribe-audio-live`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            audio: base64Audio,
            mimeType: audioBlob.type || 'audio/webm',
            chunkIndex,
            languageCode: 'en-US',
          }),
        }
      );

      if (!response.ok) {
        const errData = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(errData.error || `HTTP ${response.status}`);
      }

      const result = await response.json();
      console.log(`[LiveScribe] Chunk ${chunkIndex} transcribed:`, result.text?.slice(0, 100));
      
      setDebugInfo(prev => ({
        ...prev,
        lastLiveStatus: 'received',
        lastLiveError: null,
      }));

      return result;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[LiveScribe] Error processing chunk ${chunkIndex}:`, err);
      
      setDebugInfo(prev => ({
        ...prev,
        lastLiveStatus: 'error',
        lastLiveError: errMsg,
      }));
      
      throw err;
    }
  }, []);

  const sendCurrentChunks = useCallback(async () => {
    if (isProcessingRef.current || chunksRef.current.length === 0) {
      return;
    }

    isProcessingRef.current = true;
    const chunksToProcess = [...chunksRef.current];
    chunksRef.current = [];
    const currentIndex = chunkIndexRef.current++;

    try {
      const audioBlob = new Blob(chunksToProcess, { type: 'audio/webm' });
      if (audioBlob.size < 1000) {
        console.log('[LiveScribe] Chunk too small, skipping');
        isProcessingRef.current = false;
        return;
      }

      const result = await processAudioChunk(audioBlob, currentIndex);
      
      if (result?.text) {
        // Append to accumulated transcript
        const newText = result.text.trim();
        if (newText) {
          accumulatedTranscriptRef.current = accumulatedTranscriptRef.current
            ? `${accumulatedTranscriptRef.current} ${newText}`
            : newText;
          
          const fullTranscript = accumulatedTranscriptRef.current;
          
          setSegments(prev => {
            const newSegments = [...prev, ...(result.segments || [])];
            return newSegments;
          });
          
          setTranscript(fullTranscript);
          
          setDebugInfo(prev => ({
            ...prev,
            totalTranscriptLength: fullTranscript.length,
          }));
          
          // Call the callback to update session.transcriptText
          onTranscriptUpdate?.(fullTranscript, result.segments || []);
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      console.error('[LiveScribe] Chunk processing failed:', errMsg);
      setError(errMsg);
      onError?.(errMsg);
      // Don't stop recording on individual chunk failure
    } finally {
      isProcessingRef.current = false;
    }
  }, [processAudioChunk, onTranscriptUpdate, onError]);

  // Update running summary (Option B only)
  const updateRunningSummary = useCallback(async () => {
    const fullTranscript = accumulatedTranscriptRef.current;
    const transcriptDelta = fullTranscript.slice(lastSummaryTranscriptLengthRef.current);
    
    if (!transcriptDelta.trim()) {
      console.log('[LiveScribe] No new transcript delta for summary, skipping');
      return;
    }

    const callTime = new Date().toISOString();
    setDebugInfo(prev => ({
      ...prev,
      lastSummaryCallAt: callTime,
      lastSummaryError: null,
    }));

    try {
      console.log('[LiveScribe] Updating running summary, delta length:', transcriptDelta.length);
      
      const { data, error: fnError } = await supabase.functions.invoke('update-visit-summary', {
        body: {
          transcriptDelta,
          runningSummary: currentRunningSummaryRef.current,
          preferences
        }
      });

      if (fnError) {
        console.error('[LiveScribe] Summary update error:', fnError);
        setDebugInfo(prev => ({
          ...prev,
          lastSummaryError: fnError.message || 'Summary update failed',
        }));
        return;
      }

      if (data?.runningSummary) {
        currentRunningSummaryRef.current = data.runningSummary;
        setRunningSummary(data.runningSummary);
        onSummaryUpdate?.(data.runningSummary);
        lastSummaryTranscriptLengthRef.current = fullTranscript.length;
        console.log('[LiveScribe] Summary updated successfully');
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      console.error('[LiveScribe] Summary update failed:', err);
      setDebugInfo(prev => ({
        ...prev,
        lastSummaryError: errMsg,
      }));
    }
  }, [preferences, onSummaryUpdate]);

  const startRecording = useCallback(async () => {
    try {
      setError(null);
      setTranscript('');
      setSegments([]);
      setRunningSummary(null);
      chunkIndexRef.current = 0;
      chunksRef.current = [];
      accumulatedTranscriptRef.current = '';
      lastSummaryTranscriptLengthRef.current = 0;
      currentRunningSummaryRef.current = null;
      
      setDebugInfo({
        lastLiveCallAt: null,
        lastLiveStatus: 'idle',
        lastLiveError: null,
        lastSummaryCallAt: null,
        lastSummaryError: null,
        chunksSent: 0,
        totalTranscriptLength: 0,
      });

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      streamRef.current = stream;

      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm',
      });

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start(1000); // Collect data every second

      // Set up interval to send chunks periodically
      intervalRef.current = setInterval(() => {
        sendCurrentChunks();
      }, chunkIntervalMs);

      // Set up summary interval for Option B (every 75 seconds)
      if (liveDraftMode === 'B') {
        summaryIntervalRef.current = setInterval(() => {
          if (accumulatedTranscriptRef.current.length > lastSummaryTranscriptLengthRef.current + 50) {
            updateRunningSummary();
          }
        }, 75000);
      }

      setStatus('recording');
      console.log('[LiveScribe] Recording started, mode:', liveDraftMode);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Failed to access microphone';
      setError(errMsg);
      setStatus('error');
      setDebugInfo(prev => ({
        ...prev,
        lastLiveError: errMsg,
        lastLiveStatus: 'error',
      }));
      onError?.(errMsg);
    }
  }, [chunkIntervalMs, sendCurrentChunks, onError, liveDraftMode, updateRunningSummary]);

  const stopRecording = useCallback(async (): Promise<string> => {
    console.log('[LiveScribe] Stopping recording...');
    setStatus('finalizing');

    // Clear intervals
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (summaryIntervalRef.current) {
      clearInterval(summaryIntervalRef.current);
      summaryIntervalRef.current = null;
    }

    // Stop the media recorder
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }

    // Stop all tracks
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }

    // Process any remaining chunks
    if (chunksRef.current.length > 0) {
      try {
        await sendCurrentChunks();
      } catch (err) {
        console.error('[LiveScribe] Error processing final chunks:', err);
      }
    }

    // Wait for any in-progress processing to complete
    let waitAttempts = 0;
    while (isProcessingRef.current && waitAttempts < 30) {
      await new Promise(resolve => setTimeout(resolve, 500));
      waitAttempts++;
    }

    // Get final transcript from ref (more reliable than state)
    const finalTranscript = accumulatedTranscriptRef.current;

    // Final summary update for Option B
    if (liveDraftMode === 'B' && finalTranscript.length > lastSummaryTranscriptLengthRef.current) {
      await updateRunningSummary();
    }

    setStatus('done');
    console.log('[LiveScribe] Recording stopped, transcript length:', finalTranscript.length);

    return finalTranscript;
  }, [sendCurrentChunks, liveDraftMode, updateRunningSummary]);

  const reset = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (summaryIntervalRef.current) {
      clearInterval(summaryIntervalRef.current);
      summaryIntervalRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    mediaRecorderRef.current = null;
    chunksRef.current = [];
    chunkIndexRef.current = 0;
    isProcessingRef.current = false;
    accumulatedTranscriptRef.current = '';
    lastSummaryTranscriptLengthRef.current = 0;
    currentRunningSummaryRef.current = null;
    setStatus('idle');
    setTranscript('');
    setSegments([]);
    setError(null);
    setRunningSummary(null);
    setDebugInfo({
      lastLiveCallAt: null,
      lastLiveStatus: 'idle',
      lastLiveError: null,
      lastSummaryCallAt: null,
      lastSummaryError: null,
      chunksSent: 0,
      totalTranscriptLength: 0,
    });
  }, []);

  return {
    status,
    transcript,
    segments,
    error,
    runningSummary,
    debugInfo,
    startRecording,
    stopRecording,
    reset,
  };
}
