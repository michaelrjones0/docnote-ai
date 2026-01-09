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
// VITE_DICTATION_ENABLED: master switch for dictation feature (default: false - frozen until relay ready)
const DICTATION_ENABLED = import.meta.env.VITE_DICTATION_ENABLED === 'true';
const DICTATION_ENGINE = import.meta.env.VITE_DICTATION_ENGINE || 'batch';
const STREAMING_ENABLED = import.meta.env.VITE_STREAMING_ENABLED === 'true';
const DEEPGRAM_RELAY_URL = import.meta.env.VITE_DEEPGRAM_RELAY_URL || '';

// Export for UI components to conditionally render
export const isDictationEnabled = (): boolean => DICTATION_ENABLED;

// Determine preferred mode: deepgram (only if relay configured) > streaming > batch
function getPreferredMode(): DictationMode {
  // Deepgram only works if relay URL is configured - no relay = no Deepgram
  if (DICTATION_ENGINE === 'deepgram' && DEEPGRAM_RELAY_URL) return 'deepgram';
  if (STREAMING_ENABLED) return 'streaming';
  return 'batch';
}

// Check if Deepgram was requested but relay not configured
function isDeepgramRequestedButUnavailable(): boolean {
  return DICTATION_ENGINE === 'deepgram' && !DEEPGRAM_RELAY_URL;
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

  // If dictation is disabled, return a no-op interface
  const dictationDisabled = !DICTATION_ENABLED;

  const [fallbackMode, setFallbackMode] = useState<DictationMode | null>(() => {
    // If Deepgram was requested but no relay URL, start in fallback mode immediately
    if (isDeepgramRequestedButUnavailable()) {
      return 'batch';
    }
    return null;
  });
  const [fallbackReason, setFallbackReason] = useState<string | undefined>(() => {
    if (isDeepgramRequestedButUnavailable()) {
      return 'Deepgram unavailable — using batch dictation';
    }
    return undefined;
  });
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptedModeRef = useRef<DictationMode | null>(null);
  const hasNotifiedFallbackRef = useRef(false);

  // Show one-time toast if Deepgram requested but unavailable (on first toggle)
  const notifyDeepgramUnavailableOnce = useCallback(() => {
    if (isDeepgramRequestedButUnavailable() && !hasNotifiedFallbackRef.current) {
      hasNotifiedFallbackRef.current = true;
      onError?.('Deepgram unavailable — using batch dictation');
    }
  }, [onError]);

  // Handler for streaming mode errors - triggers immediate fallback
  const handleStreamingError = useCallback((error: string) => {
    const preferredMode = getPreferredMode();
    
    // Check if this is an explicit "disabled" signal from the edge function
    const isDisabledError = error.includes('DEEPGRAM_DISABLED') || 
                            error.includes('unsupported') ||
                            error.includes('unavailable');
    
    // Only fallback if we haven't already and we're in a streaming mode
    if (!fallbackMode && (preferredMode === 'deepgram' || preferredMode === 'streaming')) {
      console.log('[useDictation] Streaming failed, falling back to batch:', error);
      setFallbackMode('batch');
      
      // Friendly reason for display
      const friendlyReason = isDisabledError 
        ? 'Deepgram unavailable — using batch dictation'
        : `Fallback: ${error}`;
      setFallbackReason(friendlyReason);
      
      // Only call onError once to show toast
      if (!hasNotifiedFallbackRef.current) {
        hasNotifiedFallbackRef.current = true;
        onError?.(friendlyReason);
      }
      return; // Don't call onError again below
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
    // Wrap toggle to notify user once if Deepgram was requested but unavailable
    const wrappedToggle = async () => {
      notifyDeepgramUnavailableOnce();
      return batch.toggle();
    };

    return {
      status: mapBatchStatus(batch.status),
      toggle: wrappedToggle,
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
    notifyDeepgramUnavailableOnce,
  ]);

  // If dictation is disabled, return disabled interface
  if (dictationDisabled) {
    return {
      status: 'idle',
      toggle: () => {
        onError?.('Dictation is disabled. Set VITE_DICTATION_ENABLED=true to enable.');
      },
      stop: () => {},
      error: null,
      activeFieldId: null,
      partialText: undefined,
      streamHealth: undefined,
      mode: 'batch',
      fallbackReason: 'Dictation frozen until relay is configured',
    };
  }

  return result;
}
