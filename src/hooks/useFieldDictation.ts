/**
 * useFieldDictation - Reusable hook for field-level voice dictation.
 * 
 * Designed to be modular and reusable across web and mobile platforms.
 * Does not make browser-only assumptions beyond the standard Web Audio API.
 * 
 * Architecture notes:
 * - Uses MediaRecorder API for audio capture (also available in React Native via bridges)
 * - Sends audio to existing transcribe-audio-live edge function
 * - Manages state per-field with global singleton to enforce single active field
 * - PHI-safe: No transcript content is logged
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { safeErrorLog } from '@/lib/debug';

export type DictationStatus = 'idle' | 'listening' | 'transcribing' | 'error';

interface DictationState {
  status: DictationStatus;
  error: string | null;
}

interface UseFieldDictationOptions {
  fieldId: string;
  onInsertText: (text: string, cursorPosition?: number) => void;
  onError?: (error: string) => void;
}

// Global registry to enforce single active dictation field
const activeFieldRef = { current: null as string | null };
const stopActiveCallbackRef = { current: null as (() => Promise<void>) | null };

export function useFieldDictation({
  fieldId,
  onInsertText,
  onError,
}: UseFieldDictationOptions) {
  const [state, setState] = useState<DictationState>({
    status: 'idle',
    error: null,
  });

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const isStoppingRef = useRef(false);

  // Cleanup function to release resources
  const cleanup = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    mediaRecorderRef.current = null;
    chunksRef.current = [];
    isStoppingRef.current = false;
  }, []);

  // Stop recording and transcribe
  const stopRecording = useCallback(async (): Promise<void> => {
    if (isStoppingRef.current) return;
    
    const recorder = mediaRecorderRef.current;
    // Use recorder.state instead of React state to avoid stale closure issues
    // when this callback is invoked from another field via stopActiveCallbackRef
    if (!recorder || recorder.state !== 'recording') {
      cleanup();
      return;
    }

    isStoppingRef.current = true;

    return new Promise((resolve) => {
      const recorder = mediaRecorderRef.current;
      if (!recorder) {
        cleanup();
        resolve();
        return;
      }

      recorder.onstop = async () => {
        // Clear active field tracking
        if (activeFieldRef.current === fieldId) {
          activeFieldRef.current = null;
          stopActiveCallbackRef.current = null;
        }

        // Collect audio
        const audioBlob = new Blob(chunksRef.current, { type: 'audio/webm' });
        
        // Check if we have actual audio
        if (audioBlob.size < 100) {
          cleanup();
          setState({ status: 'idle', error: null });
          resolve();
          return;
        }

        setState({ status: 'transcribing', error: null });

        try {
          // Convert to base64
          const base64 = await blobToBase64(audioBlob);
          
          // Call transcription API
          const { data, error: fnError } = await supabase.functions.invoke('transcribe-audio-live', {
            body: {
              audio: base64,
              chunkIndex: 0,
              mimeType: audioBlob.type || 'audio/webm',
            },
          });

          if (fnError) {
            throw fnError;
          }

          const text = data?.text?.trim() || '';
          
          if (text) {
            onInsertText(text);
          }

          setState({ status: 'idle', error: null });
        } catch (err) {
          safeErrorLog('[useFieldDictation] Transcription error:', err);
          const errorMessage = err instanceof Error ? err.message : 'Transcription failed';
          setState({ status: 'error', error: errorMessage });
          onError?.(errorMessage);
          
          // Return to idle after showing error briefly
          setTimeout(() => {
            setState({ status: 'idle', error: null });
          }, 2000);
        } finally {
          cleanup();
          resolve();
        }
      };

      // Stop the media stream first
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
      
      recorder.stop();
    });
  }, [fieldId, onInsertText, onError, cleanup]);

  // Start recording
  const startRecording = useCallback(async () => {
    // If another field is active, stop it first
    if (activeFieldRef.current && activeFieldRef.current !== fieldId) {
      if (stopActiveCallbackRef.current) {
        await stopActiveCallbackRef.current();
      }
    }

    // If this field is already listening, stop it
    if (state.status === 'listening') {
      await stopRecording();
      return;
    }

    try {
      chunksRef.current = [];
      
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

      mediaRecorderRef.current = recorder;
      recorder.start(500); // Collect chunks every 500ms

      // Register as active field
      activeFieldRef.current = fieldId;
      stopActiveCallbackRef.current = stopRecording;

      setState({ status: 'listening', error: null });
    } catch (err) {
      safeErrorLog('[useFieldDictation] Microphone access error:', err);
      const errorMessage = err instanceof Error 
        ? err.message 
        : 'Failed to access microphone. Please check permissions.';
      setState({ status: 'error', error: errorMessage });
      onError?.(errorMessage);
      
      // Return to idle after showing error
      setTimeout(() => {
        setState({ status: 'idle', error: null });
      }, 2000);
    }
  }, [fieldId, state.status, stopRecording, onError]);

  // Toggle function for simple on/off control
  const toggle = useCallback(async () => {
    if (state.status === 'listening') {
      await stopRecording();
    } else if (state.status === 'idle' || state.status === 'error') {
      await startRecording();
    }
    // If transcribing, ignore toggle
  }, [state.status, startRecording, stopRecording]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (activeFieldRef.current === fieldId) {
        cleanup();
        activeFieldRef.current = null;
        stopActiveCallbackRef.current = null;
      }
    };
  }, [fieldId, cleanup]);

  // Check if this field is the active one
  const isActive = activeFieldRef.current === fieldId;

  return {
    status: state.status,
    error: state.error,
    isActive,
    toggle,
    startRecording,
    stopRecording,
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
