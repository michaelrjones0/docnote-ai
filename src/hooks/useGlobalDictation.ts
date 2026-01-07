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
  const pendingBlobsRef = useRef<Blob[]>([]);
  const isProcessingRef = useRef(false);
  const chunkIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
    pendingBlobsRef.current = [];
    isProcessingRef.current = false;
    setIsDictating(false);
  }, [setIsDictating]);

  // Process next blob from queue sequentially
  const processNextBlob = useCallback(async () => {
    if (isProcessingRef.current || pendingBlobsRef.current.length === 0) return;
    
    const activeField = getActiveField();
    if (!activeField) {
      // Clear queue to prevent dumping into next field later
      pendingBlobsRef.current = [];
      safeLog('[GlobalDictation] No active field, clearing queue');
      onNoFieldFocused?.();
      return;
    }

    const blob = pendingBlobsRef.current[0];
    
    // If blob is too small, keep it and wait for next chunk to combine
    if (blob.size < MIN_BYTES) {
      safeLog('[GlobalDictation] Audio blob too small, waiting for more', { 
        audioBytes: blob.size, 
        minBytes: MIN_BYTES 
      });
      return;
    }

    // Pop the blob and start processing
    pendingBlobsRef.current.shift();
    isProcessingRef.current = true;
    setStatus('transcribing');

    try {
      // PHI-safe audio signal check using WebAudio
      const { decodeOk, rms, peak } = await getAudioLevels(blob);
      console.log('[GlobalDictation] sending audio', { 
        audioBytes: blob.size, 
        mimeType: blob.type, 
        decodeOk, 
        rms, 
        peak 
      });

      // Skip transcription if near-silence
      if (decodeOk && peak < 0.01) {
        console.log('[GlobalDictation] near-silence, skipping transcription', { 
          audioBytes: blob.size, 
          mimeType: blob.type, 
          rms, 
          peak 
        });
        onError?.('No microphone input detected (audio is near-silence). Check mic selection/permissions.');
        isProcessingRef.current = false;
        if (mediaRecorderRef.current?.state === 'recording') {
          setStatus('listening');
        }
        // Process next blob if any
        if (pendingBlobsRef.current.length > 0) {
          processNextBlob();
        }
        return;
      }

      const base64 = await blobToBase64(blob);
      const startTime = Date.now();

      const { data, error: fnError } = await supabase.functions.invoke('transcribe-audio-live', {
        body: {
          audio: base64,
          chunkIndex: 0,
          mimeType: blob.type || 'audio/webm',
        },
      });

      // PHI-safe debug log after response (no transcript text)
      console.log('[GlobalDictation] response meta', { 
        textLen: (data?.text?.trim()?.length ?? 0), 
        segmentsLen: (data?.segments?.length ?? null) 
      });

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
      // Process next blob in queue
      if (pendingBlobsRef.current.length > 0) {
        processNextBlob();
      }
    }
  }, [getActiveField, insertText, onError, onNoFieldFocused]);

  // Start recording
  const startRecording = useCallback(async () => {
    if (status !== 'idle') return;

    try {
      pendingBlobsRef.current = [];
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
        if (event.data?.size > 0) {
          pendingBlobsRef.current.push(event.data);
          processNextBlob();
        }
      };

      recorder.onstop = () => {
        cleanup();
        setStatus('idle');
      };

      mediaRecorderRef.current = recorder;
      // Start with NO timeslice - we'll use requestData() on interval
      recorder.start();

      // Set up interval to request data chunks
      chunkIntervalRef.current = setInterval(() => {
        if (recorder.state === 'recording') {
          recorder.requestData();
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
  }, [status, chunkIntervalMs, processNextBlob, cleanup, setIsDictating, onError]);

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

    // Request final data before stopping
    if (recorder.state === 'recording') {
      setStatus('transcribing');
      recorder.requestData();
      
      // Give a moment for ondataavailable to fire, then stop
      await new Promise(resolve => setTimeout(resolve, 100));
      recorder.stop();
      
      // Wait for any pending transcription to complete
      while (isProcessingRef.current || pendingBlobsRef.current.length > 0) {
        await new Promise(resolve => setTimeout(resolve, 50));
        if (!isProcessingRef.current && pendingBlobsRef.current.length > 0) {
          await processNextBlob();
        }
      }
    } else {
      cleanup();
      setStatus('idle');
    }

    safeLog('[GlobalDictation] Recording stopped');
  }, [cleanup, processNextBlob]);

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

// Helper to get audio levels for silence detection (PHI-safe)
async function getAudioLevels(blob: Blob): Promise<{ decodeOk: boolean; rms: number; peak: number }> {
  try {
    const ab = await blob.arrayBuffer();
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const audioBuf = await ctx.decodeAudioData(ab.slice(0));
    const data = audioBuf.getChannelData(0);
    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
      sumSq += data[i] * data[i];
    }
    const rms = Math.sqrt(sumSq / Math.max(1, data.length));
    await ctx.close();
    return { decodeOk: true, rms, peak };
  } catch {
    return { decodeOk: false, rms: 0, peak: 0 };
  }
}
