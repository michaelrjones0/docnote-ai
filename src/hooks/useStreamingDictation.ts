/**
 * useStreamingDictation - Real-time streaming transcription via AWS Transcribe Medical Streaming
 * 
 * Architecture:
 * - AudioWorklet captures raw PCM frames at source sample rate
 * - Downsamples to 16kHz mono PCM16 in real-time
 * - Streams audio frames over WebSocket to AWS Transcribe
 * - Receives partial results for instant feedback, commits only finalized text
 * - Text-based tail dedup (80 chars) prevents duplicates across finalized results
 * 
 * PHI-SAFE: No transcript content logged. Only timing/status diagnostics.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useDictationContext } from '@/contexts/DictationContext';
import { safeErrorLog, safeLog } from '@/lib/debug';
import { encodeAudioEvent, decodeEventMessage, parseTranscriptEvent } from '@/lib/awsTranscribeEventStream';

const DEBUG_AUDIO = true;

export type StreamingDictationStatus = 'idle' | 'connecting' | 'listening' | 'stopping';

const TARGET_SAMPLE_RATE = 16000;
const FRAME_DURATION_MS = 100; // Send audio frames every 100ms
const TAIL_DEDUP_CHARS = 80;
const CONNECT_TIMEOUT_MS = 8000; // Hard timeout for WebSocket connection

interface UseStreamingDictationOptions {
  onError?: (error: string) => void;
  onNoFieldFocused?: () => void;
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

registerProcessor('pcm-processor-stream', PCMProcessor);
`;

export function useStreamingDictation({
  onError,
  onNoFieldFocused,
}: UseStreamingDictationOptions = {}) {
  const { insertText, getActiveField, setIsDictating, activeFieldId } = useDictationContext();
  
  const [status, setStatus] = useState<StreamingDictationStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [partialText, setPartialText] = useState<string>('');

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
  const lastFinalizedResultIdRef = useRef<string>('');

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

  // Convert Float32 to PCM16
  const floatToPCM16 = useCallback((floatData: Float32Array): Int16Array => {
    const pcm16 = new Int16Array(floatData.length);
    for (let i = 0; i < floatData.length; i++) {
      const s = Math.max(-1, Math.min(1, floatData[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return pcm16;
  }, []);

  // Cleanup function
  const cleanup = useCallback(() => {
    isActiveRef.current = false;
    
    // Clear connect timeout
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
    lastFinalizedResultIdRef.current = '';
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
    
    // Resample and convert
    const resampled = resampleToMono16k(combined, sourceSampleRateRef.current);
    const pcm16 = floatToPCM16(resampled);
    
    // Encode as AWS event stream message
    const eventMessage = encodeAudioEvent(pcm16);
    
    try {
      wsRef.current.send(eventMessage);
    } catch (err) {
      safeErrorLog('[StreamingDictation] Failed to send audio frame:', err);
    }
  }, [resampleToMono16k, floatToPCM16]);

  // Handle WebSocket messages (transcript results)
  const handleTranscriptMessage = useCallback((data: ArrayBuffer) => {
    const decoded = decodeEventMessage(new Uint8Array(data));
    if (!decoded) return;
    
    const messageType = decoded.headers[':message-type'];
    const eventType = decoded.headers[':event-type'];
    const exceptionType = decoded.headers[':exception-type'];
    
    if (messageType === 'exception') {
      // Parse AWS exception payload for debugging (PHI-safe - only error codes, no URLs/creds)
      try {
        const payloadText = new TextDecoder().decode(decoded.payload);
        const exceptionData = JSON.parse(payloadText);
        const errorCode = exceptionData?.Code || exceptionData?.ErrorCode || exceptionType || 'Unknown';
        // Extract only the error type, mask any URLs or credentials
        const rawMsg = exceptionData?.Message || exceptionData?.message || '';
        const safeMsg = rawMsg.replace(/wss:\/\/[^\s]+/g, '[MASKED_URL]')
                              .replace(/X-Amz-[A-Za-z-]+=[^\s&]+/g, '[MASKED]')
                              .replace(/AKIA[A-Z0-9]{16}/g, '[MASKED_KEY]');
        console.error('[StreamingDictation] AWS exception:', { 
          errorCode, 
          exceptionType,
          message: safeMsg 
        });
        // Show user-friendly error without sensitive details
        const userError = errorCode === 'InvalidSignatureException' 
          ? 'Authentication failed - please try again'
          : `Transcription error: ${errorCode}`;
        setError(userError);
        onError?.(userError);
      } catch {
        console.error('[StreamingDictation] AWS exception (raw):', { exceptionType, eventType });
        setError('Transcription error');
        onError?.('Transcription error');
      }
      return;
    }
    
    if (messageType !== 'event' || eventType !== 'TranscriptEvent') return;
    
    const results = parseTranscriptEvent(decoded.payload);
    
    for (const result of results) {
      const transcript = result.alternatives[0]?.transcript || '';
      
      if (result.isPartial) {
        // Show partial result as preview
        setPartialText(transcript);
      } else {
        // Finalized result - commit to text field
        if (result.resultId === lastFinalizedResultIdRef.current) continue; // Skip duplicate
        lastFinalizedResultIdRef.current = result.resultId;
        
        setPartialText(''); // Clear partial preview
        
        if (!transcript.trim()) continue;
        
        // Text-based dedup
        let textToInsert = transcript.trim();
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
              console.log('[StreamingDictation] trimmed overlap', { overlapLen });
            }
          }
        }
        
        if (textToInsert) {
          const toInsert = textToInsert + ' ';
          const inserted = insertText(toInsert);
          if (inserted) {
            const combined = tail + toInsert;
            lastInsertedTailRef.current = combined.slice(-TAIL_DEDUP_CHARS);
            if (DEBUG_AUDIO) {
              console.log('[StreamingDictation] committed text', { len: toInsert.length });
            }
          }
        }
      }
    }
  }, [insertText, onError]);

  // Start streaming session
  const startRecording = useCallback(async () => {
    if (status !== 'idle') return;

    try {
      sessionIdRef.current++;
      pcmBufferRef.current = [];
      lastInsertedTailRef.current = '';
      lastFinalizedResultIdRef.current = '';
      setError(null);
      setPartialText('');
      setStatus('connecting');

      if (DEBUG_AUDIO) {
        console.log('[StreamingDictation] startRecording', { sessionId: sessionIdRef.current });
      }

      // Get presigned WebSocket URL from edge function
      const { data: urlData, error: urlError } = await supabase.functions.invoke('transcribe-stream-start', {
        body: { languageCode: 'en-US', sampleRate: TARGET_SAMPLE_RATE }
      });

      if (urlError || !urlData?.url) {
        throw new Error(urlError?.message || 'Failed to get streaming URL');
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
      const workletNode = new AudioWorkletNode(audioContext, 'pcm-processor-stream');
      workletNodeRef.current = workletNode;

      // Handle PCM data from worklet
      workletNode.port.onmessage = (event) => {
        if (!isActiveRef.current) return;
        
        const { pcmData } = event.data;
        if (pcmData) {
          pcmBufferRef.current.push(new Float32Array(pcmData));
        }
      };

      // Connect WebSocket with hard timeout
      const ws = new WebSocket(urlData.url);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      // Set up connect timeout - ensures stop always works even if socket never opens
      connectTimeoutRef.current = setTimeout(() => {
        if (DEBUG_AUDIO) {
          console.error('[StreamingDictation] Connect timeout after', CONNECT_TIMEOUT_MS, 'ms');
        }
        try { ws.close(); } catch {}
        wsRef.current = null;
        cleanup();
        setStatus('idle');
        setError('Connection timed out');
        onError?.('Streaming failed to connect. Try again or use batch mode.');
      }, CONNECT_TIMEOUT_MS);

      ws.onopen = () => {
        // Clear connect timeout on successful connection
        if (connectTimeoutRef.current) {
          clearTimeout(connectTimeoutRef.current);
          connectTimeoutRef.current = null;
        }
        
        if (DEBUG_AUDIO) {
          console.log('[StreamingDictation] WebSocket connected');
        }
        
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

      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          handleTranscriptMessage(event.data);
        }
      };

      ws.onerror = () => {
        // Clear connect timeout
        if (connectTimeoutRef.current) {
          clearTimeout(connectTimeoutRef.current);
          connectTimeoutRef.current = null;
        }
        safeErrorLog('[StreamingDictation] WebSocket error', new Error('WebSocket connection error'));
        setError('Connection error');
        onError?.('Connection error');
      };

      ws.onclose = (event) => {
        // Clear connect timeout
        if (connectTimeoutRef.current) {
          clearTimeout(connectTimeoutRef.current);
          connectTimeoutRef.current = null;
        }
        
        if (DEBUG_AUDIO) {
          console.log('[StreamingDictation] WebSocket closed', { code: event.code });
        }
        
        if (isActiveRef.current) {
          // Unexpected close
          cleanup();
          setStatus('idle');
        }
      };

    } catch (err) {
      safeErrorLog('[StreamingDictation] Start error:', err);
      const errorMessage = err instanceof Error ? err.message : 'Failed to start dictation';
      setError(errorMessage);
      onError?.(errorMessage);
      cleanup();
      setStatus('idle');
    }
  }, [status, cleanup, setIsDictating, onError, getActiveField, sendAudioFrame, handleTranscriptMessage, onNoFieldFocused]);

  // Stop streaming session - always works even if connecting
  const stopRecording = useCallback(async () => {
    // Allow stopping even during 'connecting' state
    if (status === 'idle') return;
    
    setStatus('stopping');
    isActiveRef.current = false;
    
    // Clear any pending connect timeout
    if (connectTimeoutRef.current) {
      clearTimeout(connectTimeoutRef.current);
      connectTimeoutRef.current = null;
    }

    if (DEBUG_AUDIO) {
      console.log('[StreamingDictation] stopRecording');
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

    // Give a moment for final results
    await new Promise(resolve => setTimeout(resolve, 300));

    // Close WebSocket gracefully
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.close(1000, 'Session ended');
    }

    // Full cleanup
    cleanup();
    setStatus('idle');
    
    safeLog('[StreamingDictation]', 'Recording stopped');
  }, [status, cleanup, sendAudioFrame]);

  // Toggle function - stop works in any non-idle state
  const toggle = useCallback(async () => {
    if (status !== 'idle') {
      await stopRecording();
      return;
    }
    await startRecording();
  }, [status, startRecording, stopRecording]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isActiveRef.current = false;
      if (frameTimerRef.current) {
        clearInterval(frameTimerRef.current);
      }
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.close(1000, 'Component unmounted');
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
    isListening: status === 'listening',
    isConnecting: status === 'connecting',
    isStopping: status === 'stopping',
    toggle,
    startRecording,
    stopRecording,
    activeFieldId,
  };
}
