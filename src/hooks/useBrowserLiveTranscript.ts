/**
 * useBrowserLiveTranscript - Browser SpeechRecognition API for immediate visual feedback
 * 
 * Uses the Web Speech API (SpeechRecognition) to show words immediately as the user speaks.
 * This is purely for UX - it does NOT replace the backend transcription pipeline.
 * 
 * PHI-Safe: No transcript content is logged to console.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { safeLog, safeWarn } from '@/lib/debug';

// Type definitions for Web Speech API (not fully typed in TypeScript)
interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  readonly length: number;
  readonly isFinal: boolean;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: Event & { error: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognition;
    webkitSpeechRecognition?: new () => SpeechRecognition;
  }
}

export type BrowserTranscriptStatus = 'idle' | 'listening' | 'error' | 'unsupported';

interface UseBrowserLiveTranscriptOptions {
  onInterimUpdate?: (interim: string, final: string) => void;
  onFinalUpdate?: (final: string) => void;
}

export function useBrowserLiveTranscript(options: UseBrowserLiveTranscriptOptions = {}) {
  const { onInterimUpdate, onFinalUpdate } = options;

  const [status, setStatus] = useState<BrowserTranscriptStatus>('idle');
  const [finalText, setFinalText] = useState('');
  const [interimText, setInterimText] = useState('');
  const [isSupported, setIsSupported] = useState(false);

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const finalTextRef = useRef('');
  const isStoppingRef = useRef(false);
  const isListeningRef = useRef(false);

  // Check browser support on mount
  useEffect(() => {
    const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
    setIsSupported(Boolean(SpeechRecognitionAPI));
    if (!SpeechRecognitionAPI) {
      safeLog('[BrowserLiveTranscript] SpeechRecognition not supported in this browser');
    }
  }, []);

  /**
   * Start listening with browser SpeechRecognition
   */
  const startListening = useCallback(() => {
    const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
    
    if (!SpeechRecognitionAPI) {
      setStatus('unsupported');
      safeWarn('[BrowserLiveTranscript] SpeechRecognition not supported');
      return;
    }

    // Clean up any existing instance
    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort();
      } catch {
        // Ignore errors on cleanup
      }
    }

    // Reset state
    setFinalText('');
    setInterimText('');
    finalTextRef.current = '';
    isStoppingRef.current = false;

    // Create new recognition instance
    const recognition = new SpeechRecognitionAPI();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      safeLog('[BrowserLiveTranscript] Started listening');
      isListeningRef.current = true;
      setStatus('listening');
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interimTranscript = '';
      let finalTranscript = finalTextRef.current;

      // Process results from resultIndex onwards
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0]?.transcript || '';

        if (result.isFinal) {
          // Append to final transcript with space
          finalTranscript = finalTranscript 
            ? `${finalTranscript} ${transcript.trim()}`
            : transcript.trim();
          finalTextRef.current = finalTranscript;
          setFinalText(finalTranscript);
          onFinalUpdate?.(finalTranscript);
        } else {
          // Accumulate interim results
          interimTranscript += transcript;
        }
      }

      setInterimText(interimTranscript);
      onInterimUpdate?.(interimTranscript, finalTextRef.current);
    };

    recognition.onerror = (event) => {
      const errorType = (event as Event & { error: string }).error;
      
      // 'no-speech' and 'aborted' are not real errors, just normal events
      if (errorType === 'no-speech' || errorType === 'aborted') {
        safeLog(`[BrowserLiveTranscript] ${errorType} (normal)`);
        return;
      }

      safeWarn(`[BrowserLiveTranscript] Error: ${errorType}`);
      
      // Only set error status for actual errors
      if (errorType === 'not-allowed' || errorType === 'service-not-allowed') {
        setStatus('error');
      }
    };

    recognition.onend = () => {
      safeLog('[BrowserLiveTranscript] Recognition ended');
      
      // If we weren't explicitly stopping, try to restart (continuous mode can stop unexpectedly)
      if (isListeningRef.current && !isStoppingRef.current) {
        safeLog('[BrowserLiveTranscript] Auto-restarting...');
        try {
          recognition.start();
          return; // Don't set idle if restarting
        } catch {
          isListeningRef.current = false;
          setStatus('idle');
        }
      } else {
        isListeningRef.current = false;
        setStatus('idle');
      }
    };

    recognitionRef.current = recognition;

    try {
      recognition.start();
    } catch (err) {
      safeWarn('[BrowserLiveTranscript] Failed to start recognition');
      setStatus('error');
    }
  }, [onInterimUpdate, onFinalUpdate, status]);

  /**
   * Stop listening immediately
   */
  const stopListening = useCallback(() => {
    isListeningRef.current = false;
    isStoppingRef.current = true;
    
    if (recognitionRef.current) {
      safeLog('[BrowserLiveTranscript] Stopping...');
      try {
        recognitionRef.current.stop();
      } catch {
        // Ignore errors on stop
      }
      recognitionRef.current = null;
    }

    setInterimText('');
    setStatus('idle');
  }, []);

  /**
   * Reset all state
   */
  const reset = useCallback(() => {
    stopListening();
    setFinalText('');
    setInterimText('');
    finalTextRef.current = '';
  }, [stopListening]);

  /**
   * Get combined display text (final + interim)
   */
  const getDisplayText = useCallback(() => {
    return { finalText, interimText };
  }, [finalText, interimText]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {
          // Ignore cleanup errors
        }
      }
    };
  }, []);

  return {
    // State
    status,
    finalText,
    interimText,
    isSupported,
    isListening: status === 'listening',

    // Actions
    startListening,
    stopListening,
    reset,
    getDisplayText,
  };
}
