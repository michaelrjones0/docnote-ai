/**
 * useGlobalDictation - Global continuous dictation hook.
 * 
 * Architecture:
 * - ONE MediaRecorder + stream (single mic session)
 * - Continuously records and emits audio chunks on interval
 * - Transcribes each chunk and inserts into currently focused field
 * - Future-proof: logic isolated here for easy swap to streaming STT
 * 
 * ============================================================================
 * DICTATION SMOKE TEST CHECKLIST:
 * ============================================================================
 * 1. Toggle global mic → speak → text appears in focused field.
 * 2. Switch focus to another field while mic is on → text goes to new field.
 * 3. Click in middle of existing text, dictate → insertion at cursor.
 * 4. No console/network logs include transcript text or base64 audio.
 * 5. If no field focused, toast "Click into a field to dictate."
 * ============================================================================
 * 
 * PHI-SAFE: No transcript content logged. Only timing/status diagnostics.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useDictationContext } from '@/contexts/DictationContext';
import { safeErrorLog, safeLog } from '@/lib/debug';

export type GlobalDictationStatus = 'idle' | 'listening' | 'transcribing';

// Minimum audio buffer size to attempt transcription (12 KB)
const MIN_BYTES = 12_000;

interface UseGlobalDictationOptions {
  chunkIntervalMs?: number;
  onError?: (error: string) => void;
  onNoFieldFocused?: () => void;
}

export function useGlobalDictation({
  chunkIntervalMs = 1200,
  onError,
  onNoFieldFocused,
}: UseGlobalDictationOptions = {}) {
  const { insertText, getActiveField, setIsDictating, activeFieldId } = useDictationContext();
  
  const [status, setStatus] = useState<GlobalDictationStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const isProcessingRef = useRef(false);
  const chunkIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingTranscriptionRef = useRef<Promise<void> | null>(null);

  // Cleanup function
  const cleanup = useCallback(() => {
    if (chunkIntervalRef.current) {
      clearInterval(chunkIntervalRef.current);
      chunkIntervalRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    mediaRecorderRef.current = null;
    chunksRef.current = [];
    isProcessingRef.current = false;
    setIsDictating(false);
  }, [setIsDictating]);

  // Process accumulated audio chunks
  const processChunks = useCallback(async () => {
    if (isProcessingRef.current || chunksRef.current.length === 0) return;
    
    const activeField = getActiveField();
    if (!activeField) {
      // Clear chunks to prevent dumping into next field later
      chunksRef.current = [];
      safeLog('[GlobalDictation] No active field, clearing chunks');
      onNoFieldFocused?.();
      return;
    }

    // Build blob to check size BEFORE clearing chunks
    const audioBlob = new Blob(chunksRef.current, { type: 'audio/webm' });
    
    // If buffer is too small, keep accumulating - do NOT clear chunks
    if (audioBlob.size < MIN_BYTES) {
      safeLog('[GlobalDictation] Audio buffer too small, accumulating', { 
        audioBytes: audioBlob.size, 
        minBytes: MIN_BYTES 
      });
      // Ensure status stays as listening if recording
      if (mediaRecorderRef.current?.state === 'recording') {
        setStatus('listening');
      }
      return;
    }

    isProcessingRef.current = true;
    setStatus('transcribing');

    // Only now copy and clear chunks (buffer is large enough)
    const audioChunks = [...chunksRef.current];
    chunksRef.current = [];

    try {
      const transcribeBlob = new Blob(audioChunks, { type: 'audio/webm' });
      
      // PHI-safe debug log before calling edge function
      console.log('[GlobalDictation] sending audioBytes:', transcribeBlob.size, 'mimeType:', transcribeBlob.type);

      const base64 = await blobToBase64(transcribeBlob);
      const startTime = Date.now();

      const { data, error: fnError } = await supabase.functions.invoke('transcribe-audio-live', {
        body: {
          audio: base64,
          chunkIndex: 0,
          mimeType: transcribeBlob.type || 'audio/webm',
        },
      });

      // PHI-safe debug log after response
      console.log('[GlobalDictation] hasText:', Boolean(data?.text?.trim()));

      safeLog('[GlobalDictation] Transcription complete', { 
        durationMs: Date.now() - startTime,
        hasText: !!data?.text 
      });

      if (fnError) {
        throw fnError;
      }

      const text = data?.text?.trim() || '';
      
      if (text) {
        const inserted = insertText(text);
        if (!inserted) {
          safeLog('[GlobalDictation] Failed to insert text - no active field');
        }
      }
    } catch (err) {
      safeErrorLog('[GlobalDictation] Transcription error:', err);
      const errorMessage = err instanceof Error ? err.message : 'Transcription failed';
      setError(errorMessage);
      onError?.(errorMessage);
    } finally {
      isProcessingRef.current = false;
      // Only set back to listening if still recording
      if (mediaRecorderRef.current?.state === 'recording') {
        setStatus('listening');
      }
    }
  }, [getActiveField, insertText, onError, onNoFieldFocused]);

  // Start recording
  const startRecording = useCallback(async () => {
    if (status !== 'idle') return;

    try {
      chunksRef.current = [];
      setError(null);
      
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
      
      const recorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm',
      });

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        // Process any remaining chunks on stop
        if (chunksRef.current.length > 0) {
          await processChunks();
        }
        cleanup();
        setStatus('idle');
      };

      mediaRecorderRef.current = recorder;
      recorder.start(500); // Collect data every 500ms

      // Set up interval to process chunks
      chunkIntervalRef.current = setInterval(() => {
        if (chunksRef.current.length > 0 && !isProcessingRef.current) {
          processChunks();
        }
      }, chunkIntervalMs);

      setStatus('listening');
      setIsDictating(true);
      safeLog('[GlobalDictation] Recording started');
    } catch (err) {
      safeErrorLog('[GlobalDictation] Microphone access error:', err);
      const errorMessage = err instanceof Error 
        ? err.message 
        : 'Failed to access microphone';
      setError(errorMessage);
      onError?.(errorMessage);
      cleanup();
    }
  }, [status, chunkIntervalMs, processChunks, cleanup, setIsDictating, onError]);

  // Stop recording
  const stopRecording = useCallback(async () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) {
      cleanup();
      setStatus('idle');
      return;
    }

    // Clear the interval first
    if (chunkIntervalRef.current) {
      clearInterval(chunkIntervalRef.current);
      chunkIntervalRef.current = null;
    }

    // If we have pending chunks, process them before stopping
    if (chunksRef.current.length > 0 && !isProcessingRef.current) {
      setStatus('transcribing');
      pendingTranscriptionRef.current = processChunks();
      await pendingTranscriptionRef.current;
    }

    if (recorder.state !== 'inactive') {
      recorder.stop();
    } else {
      cleanup();
      setStatus('idle');
    }

    safeLog('[GlobalDictation] Recording stopped');
  }, [cleanup, processChunks]);

  // Toggle function - always allow stopping if recording
  const toggle = useCallback(async () => {
    const recorder = mediaRecorderRef.current;
    const isRecording = recorder?.state === 'recording';

    if (isRecording) {
      await stopRecording();
      return;
    }

    // Only start if truly idle
    if (status === 'idle') {
      await startRecording();
    }
  }, [status, startRecording, stopRecording]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (chunkIntervalRef.current) {
        clearInterval(chunkIntervalRef.current);
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  return {
    status,
    error,
    isListening: status === 'listening',
    isTranscribing: status === 'transcribing',
    toggle,
    startRecording,
    stopRecording,
    activeFieldId,
  };
}

// Helper to convert Blob to base64
async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
