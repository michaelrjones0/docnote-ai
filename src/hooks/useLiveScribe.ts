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
    chunkIntervalMs = 8000,
    liveDraftMode = 'A',
    preferences = {}
  } = options;
  
  const [status, setStatus] = useState<LiveScribeStatus>('idle');
  const [transcript, setTranscript] = useState('');
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [runningSummary, setRunningSummary] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const chunkIndexRef = useRef(0);
  const isProcessingRef = useRef(false);
  const pendingChunksRef = useRef<Blob[]>([]);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  
  // For running summary (Option B)
  const lastSummaryTranscriptLengthRef = useRef(0);
  const summaryIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const currentRunningSummaryRef = useRef<string | null>(null);

  const processAudioChunk = useCallback(async (audioBlob: Blob, chunkIndex: number) => {
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

      return result;
    } catch (err) {
      console.error(`[LiveScribe] Error processing chunk ${chunkIndex}:`, err);
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
        setSegments(prev => {
          const newSegments = [...prev, ...(result.segments || [])];
          return newSegments;
        });
        
        setTranscript(prev => {
          const newTranscript = prev ? `${prev} ${result.text}` : result.text;
          onTranscriptUpdate?.(newTranscript, result.segments || []);
          return newTranscript;
        });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      console.error('[LiveScribe] Chunk processing failed:', errMsg);
      // Don't stop recording on individual chunk failure
    } finally {
      isProcessingRef.current = false;
    }
  }, [processAudioChunk, onTranscriptUpdate]);

  // Update running summary (Option B only)
  const updateRunningSummary = useCallback(async (fullTranscript: string) => {
    const transcriptDelta = fullTranscript.slice(lastSummaryTranscriptLengthRef.current);
    if (!transcriptDelta.trim()) return;

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
        return;
      }

      if (data?.runningSummary) {
        currentRunningSummaryRef.current = data.runningSummary;
        setRunningSummary(data.runningSummary);
        onSummaryUpdate?.(data.runningSummary);
        lastSummaryTranscriptLengthRef.current = fullTranscript.length;
      }
    } catch (err) {
      console.error('[LiveScribe] Summary update failed:', err);
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
      lastSummaryTranscriptLengthRef.current = 0;
      currentRunningSummaryRef.current = null;

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

      // Set up summary interval for Option B (every 60-90 seconds, we'll use 75)
      if (liveDraftMode === 'B') {
        summaryIntervalRef.current = setInterval(() => {
          setTranscript(currentTranscript => {
            if (currentTranscript.length > lastSummaryTranscriptLengthRef.current + 100) {
              updateRunningSummary(currentTranscript);
            }
            return currentTranscript;
          });
        }, 75000);
      }

      setStatus('recording');
      console.log('[LiveScribe] Recording started, mode:', liveDraftMode);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Failed to access microphone';
      setError(errMsg);
      setStatus('error');
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

    // Get final transcript
    let finalTranscript = '';
    setTranscript(t => {
      finalTranscript = t;
      return t;
    });

    // Final summary update for Option B
    if (liveDraftMode === 'B' && finalTranscript.length > lastSummaryTranscriptLengthRef.current) {
      await updateRunningSummary(finalTranscript);
    }

    setStatus('done');
    console.log('[LiveScribe] Recording stopped, transcript ready');

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
    lastSummaryTranscriptLengthRef.current = 0;
    currentRunningSummaryRef.current = null;
    setStatus('idle');
    setTranscript('');
    setSegments([]);
    setError(null);
    setRunningSummary(null);
  }, []);

  return {
    status,
    transcript,
    segments,
    error,
    runningSummary,
    startRecording,
    stopRecording,
    reset,
  };
}
