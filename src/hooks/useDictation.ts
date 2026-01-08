/**
 * useDictation - Unified dictation hook that selects implementation based on env flag.
 * 
 * - VITE_STREAMING_ENABLED=true → uses streaming (WebSocket to AWS Transcribe)
 * - otherwise → uses batch (reliable default)
 * 
 * Both implementations expose the same interface for the UI.
 */

import { useCallback, useMemo } from 'react';
import { useGlobalDictation } from './useGlobalDictation';
import { useStreamingDictation } from './useStreamingDictation';

// Environment-driven flag (defaults to false for safety)
const STREAMING_ENABLED = import.meta.env.VITE_STREAMING_ENABLED === 'true';

export type DictationStatus = 'idle' | 'connecting' | 'listening' | 'stopping' | 'transcribing';
export type DictationMode = 'batch' | 'streaming';

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

  // Always call both hooks (rules of hooks), but only use one
  const batch = useGlobalDictation({
    onError,
    onNoFieldFocused,
  });

  const streaming = useStreamingDictation({
    onError,
    onNoFieldFocused,
  });

  // Determine which mode to use
  const mode: DictationMode = STREAMING_ENABLED ? 'streaming' : 'batch';

  // Map batch status to unified status
  const mapBatchStatus = useCallback((batchStatus: 'idle' | 'listening' | 'transcribing'): DictationStatus => {
    return batchStatus; // Already compatible
  }, []);

  // Map streaming status to unified status
  const mapStreamingStatus = useCallback((streamingStatus: string): DictationStatus => {
    if (streamingStatus === 'disabled') return 'idle';
    return streamingStatus as DictationStatus;
  }, []);

  // Return unified interface based on mode
  const result = useMemo((): UseDictationReturn => {
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
    mapBatchStatus,
    mapStreamingStatus,
  ]);

  return result;
}
