/**
 * useDictation - Unified dictation hook that selects implementation based on env flags.
 * 
 * Priority:
 * 1. VITE_DICTATION_ENGINE='deepgram' → uses Deepgram streaming (fastest, preferred)
 * 2. VITE_STREAMING_ENABLED=true → uses AWS Transcribe streaming (legacy)
 * 3. otherwise → uses batch (reliable fallback)
 * 
 * All implementations expose the same interface for the UI.
 * 
 * SECURITY: Deepgram API key never reaches browser. Edge function provides
 * short-lived tokens that browser uses to connect directly to Deepgram.
 */

import { useCallback, useMemo } from 'react';
import { useGlobalDictation } from './useGlobalDictation';
import { useStreamingDictation } from './useStreamingDictation';
import { useDeepgramDictation } from './useDeepgramDictation';

// Environment-driven flags
const DICTATION_ENGINE = import.meta.env.VITE_DICTATION_ENGINE || 'batch';
const STREAMING_ENABLED = import.meta.env.VITE_STREAMING_ENABLED === 'true';

// Determine mode: deepgram > streaming > batch
function getMode(): DictationMode {
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
}

export function useDictation(options: UseDictationOptions = {}): UseDictationReturn {
  const { onError, onNoFieldFocused } = options;

  // Always call all hooks (rules of hooks), but only use one
  const batch = useGlobalDictation({
    onError,
    onNoFieldFocused,
  });

  const streaming = useStreamingDictation({
    onError,
    onNoFieldFocused,
  });

  const deepgram = useDeepgramDictation({
    onError,
    onNoFieldFocused,
  });

  const mode = getMode();

  // Map batch status to unified status
  const mapBatchStatus = useCallback((batchStatus: 'idle' | 'listening' | 'transcribing'): DictationStatus => {
    return batchStatus;
  }, []);

  // Map streaming/deepgram status to unified status
  const mapStreamingStatus = useCallback((streamingStatus: string): DictationStatus => {
    if (streamingStatus === 'disabled') return 'idle';
    return streamingStatus as DictationStatus;
  }, []);

  // Return unified interface based on mode
  const result = useMemo((): UseDictationReturn => {
    if (mode === 'deepgram') {
      return {
        status: mapStreamingStatus(deepgram.status),
        toggle: deepgram.toggle,
        stop: deepgram.stopRecording,
        error: deepgram.error,
        activeFieldId: deepgram.activeFieldId,
        partialText: deepgram.partialText,
        streamHealth: deepgram.streamHealth,
        mode: 'deepgram',
      };
    }

    if (mode === 'streaming') {
      return {
        status: mapStreamingStatus(streaming.status),
        toggle: streaming.toggle,
        stop: streaming.stopRecording,
        error: streaming.error,
        activeFieldId: streaming.activeFieldId,
        partialText: streaming.partialText,
        streamHealth: streaming.streamHealth,
        mode: 'streaming',
      };
    }

    // Batch mode (default)
    return {
      status: mapBatchStatus(batch.status),
      toggle: batch.toggle,
      stop: batch.stopRecording,
      error: batch.error,
      activeFieldId: batch.activeFieldId,
      partialText: undefined,
      streamHealth: undefined,
      mode: 'batch',
    };
  }, [
    mode,
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
