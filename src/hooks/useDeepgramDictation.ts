/**
 * useDeepgramDictation - Real-time streaming transcription via Deepgram
 * 
 * Architecture:
 * - Requests a short-lived token from edge function (DEEPGRAM_API_KEY never exposed)
 * - Browser connects directly to Deepgram WebSocket using temporary token
 * - AudioWorklet captures raw PCM frames at source sample rate
 * - Streams audio to Deepgram, receives partial + final results
 * - Text-based tail dedup prevents duplicates across finalized results
 * 
 * PHI-SAFE: No transcript content logged. Only timing/status diagnostics.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useDictationContext } from '@/contexts/DictationContext';
import { safeErrorLog, safeLog } from '@/lib/debug';

const DEBUG_AUDIO = true;

// Environment-driven dictation engine (defaults to 'deepgram')
const DICTATION_ENGINE = import.meta.env.VITE_DICTATION_ENGINE || 'deepgram';
const DEEPGRAM_ENABLED = DICTATION_ENGINE === 'deepgram';

export type DeepgramDictationStatus = 'idle' | 'connecting' | 'listening' | 'stopping' | 'disabled';

const TARGET_SAMPLE_RATE = 16000;
const FRAME_DURATION_MS = 100; // Send audio frames every 100ms
const TAIL_DEDUP_CHARS = 80;
const CONNECT_TIMEOUT_MS = 5000;

interface UseDeepgramDictationOptions {
  onError?: (error: string) => void;
  onNoFieldFocused?: () => void;
  onDisabled?: () => void;
}

// AudioWorklet processor code
const workletCode = `
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 2048;
    this.buffer = new Float32Array(this.bufferSize);
    this.bufferIndex = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const inputChannel = input[0];
    for (let i = 0; i < inputChannel.length; i++) {
      this.buffer[this.bufferIndex++] = inputChannel[i];
      if (this.bufferIndex >= this.bufferSize) {
        this.port.postMessage({ pcmData: this.buffer.slice() });
        this.bufferIndex = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-processor-deepgram', PCMProcessor);
`;

export function useDeepgramDictation({
  onError,
  onNoFieldFocused,
  onDisabled,
}: UseDeepgramDictationOptions = {}) {
  const { insertText, getActiveField, setIsDictating, activeFieldId } = useDictationContext();
  
  const [status, setStatus] = useState<DeepgramDictationStatus>(
    DEEPGRAM_ENABLED ? 'idle' : 'disabled'
  );
  const [error, setError] = useState<string | null>(null);
  const [partialText, setPartialText] = useState<string>('');
  const [streamHealth, setStreamHealth] = useState<'online' | 'offline' | 'connecting'>('offline');

  // Audio pipeline refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  
  // WebSocket ref
  const wsRef = useRef<WebSocket | null>(null);
  
  // PCM buffer for frame batching
  const pcmBufferRef = useRef<Float32Array[]>([]);
  const sourceSampleRateRef = useRef<number>(48000);
  const frameTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const connectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  // State refs
  const isActiveRef = useRef(false);
  const sessionIdRef = useRef(0);
  const lastInsertedTailRef = useRef<string>('');

  // Resample to 16kHz mono
  const resampleToMono16k = useCallback((inputSamples: Float32Array, sourceSampleRate: number): Float32Array => {
    const ratio = sourceSampleRate / TARGET_SAMPLE_RATE;
    const outputLength = Math.floor(inputSamples.length / ratio);
    const output = new Float32Array(outputLength);
    
    for (let i = 0; i < outputLength; i++) {
      const srcIndex = i * ratio;
      const srcIndexFloor = Math.floor(srcIndex);
      const srcIndexCeil = Math.min(srcIndexFloor + 1, inputSamples.length - 1);
      const t = srcIndex - srcIndexFloor;
      output[i] = inputSamples[srcIndexFloor] * (1 - t) + inputSamples[srcIndexCeil] * t;
    }
    
    return output;
  }, []);

  // Convert Float32 to 16-bit PCM bytes (little-endian)
  const floatToPCM16Bytes = useCallback((floatData: Float32Array): ArrayBuffer => {
    const buffer = new ArrayBuffer(floatData.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < floatData.length; i++) {
      const s = Math.max(-1, Math.min(1, floatData[i]));
      const val = s < 0 ? s * 0x8000 : s * 0x7FFF;
      view.setInt16(i * 2, val, true); // little-endian
    }
    return buffer;
  }, []);

  // Cleanup function
  const cleanup = useCallback(() => {
    isActiveRef.current = false;
    
    if (connectTimeoutRef.current) {
      clearTimeout(connectTimeoutRef.current);
      connectTimeoutRef.current = null;
    }
    
    if (frameTimerRef.current) {
      clearInterval(frameTimerRef.current);
      frameTimerRef.current = null;
    }
    
    if (wsRef.current) {
      try {
        // Send close message to Deepgram
        if (wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'CloseStream' }));
        }
        wsRef.current.close(1000, 'Session ended');
      } catch {}
      wsRef.current = null;
    }
    
    if (workletNodeRef.current) {
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }
    
    if (sourceNodeRef.current) {
      sourceNodeRef.current.disconnect();
      sourceNodeRef.current = null;
    }
    
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    
    pcmBufferRef.current = [];
    lastInsertedTailRef.current = '';
    setPartialText('');
    setIsDictating(false);
  }, [setIsDictating]);

  // Send buffered audio frame over WebSocket
  const sendAudioFrame = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    if (pcmBufferRef.current.length === 0) return;
    
    // Combine all buffered chunks
    const totalSamples = pcmBufferRef.current.reduce((sum, arr) => sum + arr.length, 0);
    if (totalSamples === 0) return;
    
    const combined = new Float32Array(totalSamples);
    let offset = 0;
    for (const chunk of pcmBufferRef.current) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    pcmBufferRef.current = [];
    
    // Resample and convert to PCM16 bytes
    const resampled = resampleToMono16k(combined, sourceSampleRateRef.current);
    const pcmBytes = floatToPCM16Bytes(resampled);
    
    try {
      wsRef.current.send(pcmBytes);
    } catch (err) {
      safeErrorLog('[DeepgramDictation] Failed to send audio frame:', err);
    }
  }, [resampleToMono16k, floatToPCM16Bytes]);

  // Handle Deepgram WebSocket messages
  const handleDeepgramMessage = useCallback((event: MessageEvent) => {
    try {
      const data = JSON.parse(event.data);
      
      if (data.type === 'Results') {
        const transcript = data.channel?.alternatives?.[0]?.transcript || '';
        const isFinal = data.is_final === true;
        const speechFinal = data.speech_final === true;
        
        if (!transcript) return;
        
        if (!isFinal) {
          // Partial result - show as preview
          setPartialText(transcript);
        } else {
          // Final result - commit to text field
          setPartialText('');
          
          let textToInsert = transcript.trim();
          if (!textToInsert) return;
          
          // Text-based dedup
          const tail = lastInsertedTailRef.current;
          
          if (tail.length > 0) {
            const maxCheck = Math.min(tail.length, textToInsert.length);
            let overlapLen = 0;
            
            for (let len = 1; len <= maxCheck; len++) {
              const tailSuffix = tail.slice(-len).toLowerCase();
              const textPrefix = textToInsert.slice(0, len).toLowerCase();
              if (tailSuffix === textPrefix) {
                overlapLen = len;
              }
            }
            
            if (overlapLen > 0) {
              textToInsert = textToInsert.slice(overlapLen).trimStart();
              if (DEBUG_AUDIO) {
                console.log('[DeepgramDictation] trimmed overlap', { overlapLen });
              }
            }
          }
          
          if (textToInsert) {
            // Add space after speech_final (end of utterance), otherwise just text
            const toInsert = speechFinal ? textToInsert + ' ' : textToInsert;
            const inserted = insertText(toInsert);
            if (inserted) {
              const combined = tail + toInsert;
              lastInsertedTailRef.current = combined.slice(-TAIL_DEDUP_CHARS);
              if (DEBUG_AUDIO) {
                console.log('[DeepgramDictation] committed text', { len: toInsert.length, speechFinal });
              }
            }
          }
        }
      } else if (data.type === 'Error') {
        const errorMsg = data.message || 'Deepgram error';
        console.error('[DeepgramDictation] Error:', errorMsg);
        setError(errorMsg);
        onError?.(errorMsg);
      } else if (data.type === 'Metadata') {
        if (DEBUG_AUDIO) {
          console.log('[DeepgramDictation] Metadata received', { requestId: data.request_id });
        }
      }
    } catch (err) {
      safeErrorLog('[DeepgramDictation] Failed to parse message:', err);
    }
  }, [insertText, onError]);

  // Close any existing WebSocket
  const closeExistingWebSocket = useCallback(() => {
    if (wsRef.current) {
      try {
        if (wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'CloseStream' }));
        }
        wsRef.current.close(1000, 'Replaced by new session');
      } catch {}
      wsRef.current = null;
    }
    if (connectTimeoutRef.current) {
      clearTimeout(connectTimeoutRef.current);
      connectTimeoutRef.current = null;
    }
  }, []);

  // Start streaming session
  const startRecording = useCallback(async () => {
    if (!DEEPGRAM_ENABLED || status === 'disabled') {
      if (DEBUG_AUDIO) {
        console.log('[DeepgramDictation] Deepgram disabled');
      }
      onDisabled?.();
      return;
    }
    
    if (status !== 'idle') return;

    closeExistingWebSocket();

    try {
      sessionIdRef.current++;
      pcmBufferRef.current = [];
      lastInsertedTailRef.current = '';
      setError(null);
      setPartialText('');
      setStatus('connecting');
      setStreamHealth('connecting');

      if (DEBUG_AUDIO) {
        console.log('[DeepgramDictation] startRecording', { sessionId: sessionIdRef.current });
      }

      // Get temporary token from edge function
      const { data: tokenData, error: tokenError } = await supabase.functions.invoke('deepgram-token');

      if (tokenError || !tokenData?.token) {
        throw new Error(tokenError?.message || 'Failed to get Deepgram token');
      }

      // Get microphone stream
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;

      // Create AudioContext
      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      sourceSampleRateRef.current = audioContext.sampleRate;

      // Load AudioWorklet
      const workletBlob = new Blob([workletCode], { type: 'application/javascript' });
      const workletUrl = URL.createObjectURL(workletBlob);
      
      try {
        await audioContext.audioWorklet.addModule(workletUrl);
      } finally {
        URL.revokeObjectURL(workletUrl);
      }

      // Create worklet node
      const workletNode = new AudioWorkletNode(audioContext, 'pcm-processor-deepgram');
      workletNodeRef.current = workletNode;

      // Handle PCM data from worklet
      workletNode.port.onmessage = (event) => {
        if (!isActiveRef.current) return;
        
        const { pcmData } = event.data;
        if (pcmData) {
          pcmBufferRef.current.push(new Float32Array(pcmData));
        }
      };

      // Build Deepgram WebSocket URL with query parameters
      const dgParams = new URLSearchParams({
        model: 'nova-2-medical', // Medical-optimized model
        language: 'en-US',
        punctuate: 'true',
        interim_results: 'true',
        endpointing: '300', // 300ms silence for utterance end
        sample_rate: String(TARGET_SAMPLE_RATE),
        encoding: 'linear16',
        channels: '1',
      });
      
      const dgUrl = `wss://api.deepgram.com/v1/listen?${dgParams.toString()}`;
      
      // Connect WebSocket with token auth
      const ws = new WebSocket(dgUrl, ['token', tokenData.token]);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      // Set up connect timeout
      connectTimeoutRef.current = setTimeout(() => {
        if (DEBUG_AUDIO) {
          console.error('[DeepgramDictation] Connect timeout after', CONNECT_TIMEOUT_MS, 'ms');
        }
        try { ws.close(); } catch {}
        wsRef.current = null;
        cleanup();
        setStatus('idle');
        setStreamHealth('offline');
        setError('Connection timed out');
        onError?.('Deepgram connection timed out');
      }, CONNECT_TIMEOUT_MS);

      ws.onopen = () => {
        if (connectTimeoutRef.current) {
          clearTimeout(connectTimeoutRef.current);
          connectTimeoutRef.current = null;
        }
        
        if (DEBUG_AUDIO) {
          console.log('[DeepgramDictation] WebSocket connected');
        }
        
        setStreamHealth('online');
        isActiveRef.current = true;
        setStatus('listening');
        setIsDictating(true);
        
        // Connect audio graph
        const sourceNode = audioContext.createMediaStreamSource(stream);
        sourceNodeRef.current = sourceNode;
        sourceNode.connect(workletNode);
        
        // Start sending audio frames at regular intervals
        frameTimerRef.current = setInterval(() => {
          if (!isActiveRef.current) return;
          
          const activeField = getActiveField();
          if (!activeField) {
            pcmBufferRef.current = [];
            onNoFieldFocused?.();
            return;
          }
          
          sendAudioFrame();
        }, FRAME_DURATION_MS);
      };

      ws.onmessage = handleDeepgramMessage;

      ws.onerror = () => {
        if (connectTimeoutRef.current) {
          clearTimeout(connectTimeoutRef.current);
          connectTimeoutRef.current = null;
        }
        safeErrorLog('[DeepgramDictation] WebSocket error', new Error('WebSocket connection error'));
        setStreamHealth('offline');
        setError('Connection error');
        onError?.('Deepgram connection error');
      };

      ws.onclose = (event) => {
        if (connectTimeoutRef.current) {
          clearTimeout(connectTimeoutRef.current);
          connectTimeoutRef.current = null;
        }
        
        if (DEBUG_AUDIO) {
          console.log('[DeepgramDictation] WebSocket closed', { code: event.code });
        }
        
        if (isActiveRef.current) {
          cleanup();
          setStatus('idle');
          setStreamHealth('offline');
        }
      };

    } catch (err) {
      safeErrorLog('[DeepgramDictation] Start error:', err);
      const errorMessage = err instanceof Error ? err.message : 'Failed to start dictation';
      setStreamHealth('offline');
      setError(errorMessage);
      onError?.(errorMessage);
      cleanup();
      setStatus('idle');
    }
  }, [status, cleanup, setIsDictating, onError, getActiveField, sendAudioFrame, handleDeepgramMessage, onNoFieldFocused, onDisabled, closeExistingWebSocket]);

  // Stop streaming session
  const stopRecording = useCallback(async () => {
    if (status === 'idle' || status === 'disabled') return;
    
    setStatus('stopping');
    isActiveRef.current = false;
    setStreamHealth('offline');
    
    if (connectTimeoutRef.current) {
      clearTimeout(connectTimeoutRef.current);
      connectTimeoutRef.current = null;
    }

    if (DEBUG_AUDIO) {
      console.log('[DeepgramDictation] stopRecording');
    }

    // Stop audio capture
    if (frameTimerRef.current) {
      clearInterval(frameTimerRef.current);
      frameTimerRef.current = null;
    }

    // Send any remaining audio
    if (pcmBufferRef.current.length > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
      sendAudioFrame();
    }

    // Give time for final results
    await new Promise(resolve => setTimeout(resolve, 300));

    cleanup();
    setStatus('idle');
    
    safeLog('[DeepgramDictation]', 'Recording stopped');
  }, [status, cleanup, sendAudioFrame]);

  // Toggle function
  const toggle = useCallback(async () => {
    if (!DEEPGRAM_ENABLED || status === 'disabled') {
      onDisabled?.();
      return;
    }
    
    if (status !== 'idle') {
      await stopRecording();
      return;
    }
    await startRecording();
  }, [status, startRecording, stopRecording, onDisabled]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isActiveRef.current = false;
      if (frameTimerRef.current) {
        clearInterval(frameTimerRef.current);
      }
      if (wsRef.current) {
        try {
          if (wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: 'CloseStream' }));
          }
          wsRef.current.close(1000, 'Component unmounted');
        } catch {}
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close().catch(() => {});
      }
    };
  }, []);

  return {
    status,
    error,
    partialText,
    streamHealth,
    isListening: status === 'listening',
    isConnecting: status === 'connecting',
    isStopping: status === 'stopping',
    isDisabled: !DEEPGRAM_ENABLED || status === 'disabled',
    toggle,
    startRecording,
    stopRecording,
    activeFieldId,
    DEEPGRAM_ENABLED,
  };
}
