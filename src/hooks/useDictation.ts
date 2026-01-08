/**
 * useDictation - Unified dictation hook for field insertion (scratchpad, SOAP fields, forms).
 * 
 * PURPOSE: Real-time voice-to-text for individual text fields.
 * NOT for encounter recording (which uses useLiveScribe → AWS).
 * 
 * TRANSCRIPTION ENGINE SEPARATION:
 * - Deepgram (VITE_DICTATION_ENGINE='deepgram'): Fast streaming for field dictation
 * - AWS Transcribe Medical (useLiveScribe): High-fidelity batch for clinical notes
 * 
 * TRANSCRIPT SOURCE RULES:
 * - Deepgram output = draft quality (instant, for typing assistance)
 * - AWS batch output = refined final (for note generation)
 * - Never block UX on AWS - user can generate immediately from live/Deepgram
 * - "Refined transcript available → Use / Regenerate" when AWS batch completes
 * 
 * Priority:
 * 1. VITE_DICTATION_ENGINE='deepgram' → uses Deepgram streaming (fastest, preferred)
 * 2. VITE_STREAMING_ENABLED=true → uses AWS Transcribe streaming (legacy)
 * 3. otherwise → uses batch (reliable fallback)
 * 
 * RESILIENCE:
 * - Automatic fallback to batch if Deepgram/streaming fails to connect within 5s
 * - Stop always works regardless of connection state
 * 
 * SECURITY: Deepgram API key never reaches browser. Edge function provides
 * short-lived tokens that browser uses to connect directly to Deepgram.
 */

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useGlobalDictation } from './useGlobalDictation';
import { useStreamingDictation } from './useStreamingDictation';
import { useDeepgramDictation } from './useDeepgramDictation';

// Environment-driven flags
const DICTATION_ENGINE = import.meta.env.VITE_DICTATION_ENGINE || 'batch';
const STREAMING_ENABLED = import.meta.env.VITE_STREAMING_ENABLED === 'true';

// Determine preferred mode: deepgram > streaming > batch
function getPreferredMode(): DictationMode {
  if (DICTATION_ENGINE === 'deepgram') return 'deepgram';
  if (STREAMING_ENABLED) return 'streaming';
  return 'batch';
}

export type DictationStatus = 'idle' | 'connecting' | 'listening' | 'stopping' | 'transcribing';
export type DictationMode = 'batch' | 'streaming' | 'deepgram';

export interface UseDictationOptions {
  onError?: (error: string) => void;
  onNoFieldFocused?: () => void;
}

export interface UseDictationReturn {
  status: DictationStatus;
  toggle: () => Promise<void> | void;
  stop: () => Promise<void> | void;
  error: string | null;
  activeFieldId: string | null;
  partialText?: string;
  streamHealth?: 'online' | 'offline' | 'connecting';
  mode: DictationMode;
  fallbackReason?: string;
}

const FALLBACK_TIMEOUT_MS = 5000;

export function useDictation(options: UseDictationOptions = {}): UseDictationReturn {
  const { onError, onNoFieldFocused } = options;

  const [fallbackMode, setFallbackMode] = useState<DictationMode | null>(null);
  const [fallbackReason, setFallbackReason] = useState<string | undefined>(undefined);
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptedModeRef = useRef<DictationMode | null>(null);

  // Handler for streaming mode errors - triggers fallback
  const handleStreamingError = useCallback((error: string) => {
    const preferredMode = getPreferredMode();
    
    // Only fallback if we haven't already and we're in a streaming mode
    if (!fallbackMode && (preferredMode === 'deepgram' || preferredMode === 'streaming')) {
      console.log('[useDictation] Streaming failed, falling back to batch:', error);
      setFallbackMode('batch');
      setFallbackReason(`Fallback: ${error}`);
    }
    
    onError?.(error);
  }, [fallbackMode, onError]);

  // Always call all hooks (rules of hooks), but only use one
  const batch = useGlobalDictation({
    onError,
    onNoFieldFocused,
  });

  const streaming = useStreamingDictation({
    onError: handleStreamingError,
    onNoFieldFocused,
  });

  const deepgram = useDeepgramDictation({
    onError: handleStreamingError,
    onNoFieldFocused,
  });

  // Determine effective mode (fallback overrides preferred)
  const preferredMode = getPreferredMode();
  const effectiveMode = fallbackMode || preferredMode;

  // Track when we start connecting to detect timeout
  useEffect(() => {
    const isStreaming = effectiveMode === 'deepgram' || effectiveMode === 'streaming';
    const currentStatus = effectiveMode === 'deepgram' ? deepgram.status : 
                          effectiveMode === 'streaming' ? streaming.status : batch.status;
    
    if (isStreaming && currentStatus === 'connecting' && !fallbackMode) {
      attemptedModeRef.current = effectiveMode;
      
      // Set timeout for fallback
      fallbackTimerRef.current = setTimeout(() => {
        const stillConnecting = effectiveMode === 'deepgram' 
          ? deepgram.status === 'connecting'
          : streaming.status === 'connecting';
          
        if (stillConnecting && !fallbackMode) {
          console.log('[useDictation] Connection timeout, falling back to batch');
          setFallbackMode('batch');
          setFallbackReason('Timeout: Connection took too long');
        }
      }, FALLBACK_TIMEOUT_MS);
    } else if (currentStatus === 'listening' || currentStatus === 'idle') {
      // Clear timeout on success or idle
      if (fallbackTimerRef.current) {
        clearTimeout(fallbackTimerRef.current);
        fallbackTimerRef.current = null;
      }
    }

    return () => {
      if (fallbackTimerRef.current) {
        clearTimeout(fallbackTimerRef.current);
        fallbackTimerRef.current = null;
      }
    };
  }, [effectiveMode, deepgram.status, streaming.status, batch.status, fallbackMode]);

  // Reset fallback when successfully going back to idle
  useEffect(() => {
    const currentStatus = effectiveMode === 'deepgram' ? deepgram.status : 
                          effectiveMode === 'streaming' ? streaming.status : batch.status;
    
    // When we're back to idle after using batch fallback, clear it so next attempt tries preferred mode
    if (fallbackMode === 'batch' && batch.status === 'idle') {
      // Don't clear immediately - wait for next toggle to retry streaming
      // This keeps the fallback active for the current session
    }
  }, [effectiveMode, fallbackMode, batch.status, deepgram.status, streaming.status]);

  // Map batch status to unified status
  const mapBatchStatus = useCallback((batchStatus: 'idle' | 'listening' | 'transcribing'): DictationStatus => {
    return batchStatus;
  }, []);

  // Map streaming/deepgram status to unified status
  const mapStreamingStatus = useCallback((streamingStatus: string): DictationStatus => {
    if (streamingStatus === 'disabled') return 'idle';
    return streamingStatus as DictationStatus;
  }, []);

  // Return unified interface based on effective mode
  const result = useMemo((): UseDictationReturn => {
    if (effectiveMode === 'deepgram' && !fallbackMode) {
      return {
        status: mapStreamingStatus(deepgram.status),
        toggle: deepgram.toggle,
        stop: deepgram.stopRecording,
        error: deepgram.error,
        activeFieldId: deepgram.activeFieldId,
        partialText: deepgram.partialText,
        streamHealth: deepgram.streamHealth,
        mode: 'deepgram',
        fallbackReason: undefined,
      };
    }

    if (effectiveMode === 'streaming' && !fallbackMode) {
      return {
        status: mapStreamingStatus(streaming.status),
        toggle: streaming.toggle,
        stop: streaming.stopRecording,
        error: streaming.error,
        activeFieldId: streaming.activeFieldId,
        partialText: streaming.partialText,
        streamHealth: streaming.streamHealth,
        mode: 'streaming',
        fallbackReason: undefined,
      };
    }

    // Batch mode (default or fallback)
    return {
      status: mapBatchStatus(batch.status),
      toggle: batch.toggle,
      stop: batch.stopRecording,
      error: batch.error,
      activeFieldId: batch.activeFieldId,
      partialText: undefined,
      streamHealth: undefined,
      mode: 'batch',
      fallbackReason: fallbackMode ? fallbackReason : undefined,
    };
  }, [
    effectiveMode,
    fallbackMode,
    fallbackReason,
    batch.status,
    batch.toggle,
    batch.stopRecording,
    batch.error,
    batch.activeFieldId,
    streaming.status,
    streaming.toggle,
    streaming.stopRecording,
    streaming.error,
    streaming.activeFieldId,
    streaming.partialText,
    streaming.streamHealth,
    deepgram.status,
    deepgram.toggle,
    deepgram.stopRecording,
    deepgram.error,
    deepgram.activeFieldId,
    deepgram.partialText,
    deepgram.streamHealth,
    mapBatchStatus,
    mapStreamingStatus,
  ]);

  return result;
}
