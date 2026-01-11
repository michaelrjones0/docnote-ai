/**
 * useLiveTranscriptEngine - Manages Live Transcript engine selection with debug override
 * 
 * Provides engine indicator and forced engine selection for debugging.
 * 
 * Engine priority (auto mode):
 * 1. Deepgram relay (if DEEPGRAM_RELAY_URL server secret is configured)
 * 2. Browser STT (if SpeechRecognition is supported)
 * 3. Chunked backend (fallback)
 * 
 * Debug toggle: VITE_FORCE_LIVE_TRANSCRIPT_ENGINE = deepgram | browser | chunk | auto
 */

import { useState, useCallback, useEffect } from 'react';
import { usePublicConfig } from './usePublicConfig';
import { safeLog, safeWarn } from '@/lib/debug';

export type LiveTranscriptEngine = 'deepgram' | 'browser' | 'chunk';
export type EngineStatus = 'idle' | 'connecting' | 'ready' | 'error' | 'fallback' | 'loading';

export interface EngineState {
  // The engine currently being used for display
  activeEngine: LiveTranscriptEngine;
  // The intended/preferred engine (before fallback)
  preferredEngine: LiveTranscriptEngine;
  // Status of the active engine
  status: EngineStatus;
  // Human-readable label for UI
  label: string;
  // Whether we fell back from preferred engine
  didFallback: boolean;
  // Warning message if fallback occurred
  fallbackWarning: string | null;
  // Debug mode indicator
  isDebugForced: boolean;
  // Config loading state
  configLoading: boolean;
}

interface UseLiveTranscriptEngineOptions {
  // Whether Deepgram relay reached 'ready' state
  deepgramReady: boolean;
  // Whether Deepgram is connecting
  deepgramConnecting: boolean;
  // Whether Deepgram had an error
  deepgramError: boolean;
  // Whether browser STT is listening
  browserListening: boolean;
  // Whether browser STT is supported
  browserSupported: boolean;
  // Whether currently recording
  isRecording: boolean;
}

// Get forced engine from env (debug mode)
function getForcedEngine(): LiveTranscriptEngine | 'auto' {
  const forced = import.meta.env.VITE_FORCE_LIVE_TRANSCRIPT_ENGINE;
  if (forced === 'deepgram' || forced === 'browser' || forced === 'chunk') {
    return forced;
  }
  return 'auto';
}

// Check if browser SpeechRecognition is supported
function isBrowserSttSupported(): boolean {
  return Boolean(
    typeof window !== 'undefined' && 
    (window.SpeechRecognition || (window as any).webkitSpeechRecognition)
  );
}

export function useLiveTranscriptEngine(options: UseLiveTranscriptEngineOptions) {
  const {
    deepgramReady,
    deepgramConnecting,
    deepgramError,
    browserListening,
    browserSupported,
    isRecording,
  } = options;

  const [fallbackWarning, setFallbackWarning] = useState<string | null>(null);
  const [didFallback, setDidFallback] = useState(false);

  // Get runtime config
  const { config, isLoading: configLoading } = usePublicConfig();
  const deepgramConfigured = Boolean(config?.deepgramRelayUrl);

  const forcedEngine = getForcedEngine();
  const isDebugForced = forcedEngine !== 'auto';

  // Determine preferred engine (what we want to use)
  const getPreferredEngine = useCallback((): LiveTranscriptEngine => {
    if (forcedEngine !== 'auto') {
      return forcedEngine;
    }
    
    // Auto mode: prefer deepgram if configured, then browser, then chunk
    if (deepgramConfigured) {
      return 'deepgram';
    }
    if (browserSupported) {
      return 'browser';
    }
    return 'chunk';
  }, [forcedEngine, deepgramConfigured, browserSupported]);

  // Determine active engine (what's actually being used)
  const getActiveEngine = useCallback((): LiveTranscriptEngine => {
    const preferred = getPreferredEngine();
    
    // If forced and not auto, try to use that engine
    if (forcedEngine !== 'auto') {
      // Check if forced engine is available
      if (forcedEngine === 'deepgram' && !deepgramConfigured) {
        safeWarn('[EngineSelector] Forced deepgram but relay not configured - falling back');
        return browserSupported ? 'browser' : 'chunk';
      }
      if (forcedEngine === 'browser' && !browserSupported) {
        safeWarn('[EngineSelector] Forced browser but not supported - falling back to chunk');
        return 'chunk';
      }
      return forcedEngine;
    }
    
    // Auto mode: check actual availability
    if (preferred === 'deepgram') {
      // If Deepgram had error, fallback
      if (deepgramError) {
        return browserSupported ? 'browser' : 'chunk';
      }
      return 'deepgram';
    }
    
    return preferred;
  }, [forcedEngine, getPreferredEngine, deepgramConfigured, deepgramError, browserSupported]);

  // Determine engine status
  const getEngineStatus = useCallback((): EngineStatus => {
    if (configLoading) return 'loading';
    if (!isRecording) return 'idle';
    
    const active = getActiveEngine();
    const preferred = getPreferredEngine();
    
    if (active !== preferred) {
      return 'fallback';
    }
    
    if (active === 'deepgram') {
      if (deepgramConnecting) return 'connecting';
      if (deepgramReady) return 'ready';
      if (deepgramError) return 'error';
      return 'connecting';
    }
    
    if (active === 'browser') {
      if (browserListening) return 'ready';
      return 'connecting';
    }
    
    // Chunk is always "ready" when recording
    return 'ready';
  }, [configLoading, isRecording, getActiveEngine, getPreferredEngine, deepgramConnecting, deepgramReady, deepgramError, browserListening]);

  // Generate human-readable label
  const getLabel = useCallback((): string => {
    if (configLoading) {
      return 'Engine: Loading config...';
    }
    
    const active = getActiveEngine();
    const status = getEngineStatus();
    
    const engineLabels: Record<LiveTranscriptEngine, string> = {
      deepgram: 'Deepgram (relay)',
      browser: 'Browser STT',
      chunk: 'Chunked backend',
    };
    
    let label = `Engine: ${engineLabels[active]}`;
    
    if (status === 'connecting') {
      label += ' (connecting...)';
    } else if (status === 'fallback') {
      label += ' [fallback]';
    }
    
    return label;
  }, [configLoading, getActiveEngine, getEngineStatus]);

  // Track fallback state
  useEffect(() => {
    if (!isRecording) {
      // Reset fallback state when not recording
      setDidFallback(false);
      setFallbackWarning(null);
      return;
    }
    
    const preferred = getPreferredEngine();
    const active = getActiveEngine();
    
    if (active !== preferred) {
      setDidFallback(true);
      
      if (preferred === 'deepgram') {
        const message = deepgramError
          ? 'Deepgram relay unreachable — falling back to Browser STT'
          : 'Relay not configured — using Browser STT';
        setFallbackWarning(message);
        safeWarn(`[EngineSelector] ${message}`);
      } else if (preferred === 'browser') {
        setFallbackWarning('Browser STT not supported — falling back to chunked backend');
      }
    }
  }, [isRecording, getPreferredEngine, getActiveEngine, deepgramError]);

  // Build engine state object
  const engineState: EngineState = {
    activeEngine: getActiveEngine(),
    preferredEngine: getPreferredEngine(),
    status: getEngineStatus(),
    label: getLabel(),
    didFallback,
    fallbackWarning,
    isDebugForced,
    configLoading,
  };

  // Helper to check which engine should be used for display
  const shouldUseDeepgramForDisplay = engineState.activeEngine === 'deepgram';
  const shouldUseBrowserForDisplay = engineState.activeEngine === 'browser';
  const shouldUseChunkForDisplay = engineState.activeEngine === 'chunk';

  return {
    engineState,
    shouldUseDeepgramForDisplay,
    shouldUseBrowserForDisplay,
    shouldUseChunkForDisplay,
    forcedEngine,
    isDebugForced,
  };
}
