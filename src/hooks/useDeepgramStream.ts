/**
 * useDeepgramStream - Real-time encounter transcription via Deepgram relay
 * 
 * Connects to the Deepgram WebSocket relay for streaming medical transcription.
 * This is the PRIMARY transcription engine for fastest note generation.
 * 
 * Architecture:
 * - Client → Relay (wss://<RELAY_DOMAIN>) → Deepgram
 * - Relay authenticates via Supabase JWT
 * - PCM16 audio (16kHz, mono) streamed in real-time
 * - Final transcript available immediately on stop
 * 
 * PHI-Safe: No transcript content logged to console
 */

import { useRef, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { safeLog, safeWarn, safeErrorLog } from '@/lib/debug';

export type DeepgramStreamStatus = 'idle' | 'connecting' | 'recording' | 'finalizing' | 'done' | 'error';

export interface DeepgramStreamMetrics {
  stopToFinalTranscriptMs: number | null;
  audioBytesSent: number;
  partialCount: number;
  finalCount: number;
  connectionTimeMs: number | null;
}

interface UseDeepgramStreamOptions {
  relayUrl: string;
  onPartialTranscript?: (text: string) => void;
  onFinalTranscript?: (text: string) => void;
  onError?: (error: string) => void;
}

// Audio configuration for Deepgram nova-2-medical
const TARGET_SAMPLE_RATE = 16000;
const BUFFER_SIZE = 4096;
const SEND_INTERVAL_MS = 100; // Send audio every 100ms

export function useDeepgramStream(options: UseDeepgramStreamOptions) {
  const { relayUrl, onPartialTranscript, onFinalTranscript, onError } = options;
  
  const [status, setStatus] = useState<DeepgramStreamStatus>('idle');
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<DeepgramStreamMetrics>({
    stopToFinalTranscriptMs: null,
    audioBytesSent: 0,
    partialCount: 0,
    finalCount: 0,
    connectionTimeMs: null,
  });
  
  // WebSocket and audio refs
  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorNodeRef = useRef<ScriptProcessorNode | null>(null);
  const sendIntervalRef = useRef<NodeJS.Timeout | null>(null);
  
  // Audio buffer and metrics refs
  const pcmBufferRef = useRef<Int16Array[]>([]);
  const accumulatedTranscriptRef = useRef('');
  const metricsRef = useRef<DeepgramStreamMetrics>({
    stopToFinalTranscriptMs: null,
    audioBytesSent: 0,
    partialCount: 0,
    finalCount: 0,
    connectionTimeMs: null,
  });
  
  // Timing refs
  const connectStartRef = useRef<number | null>(null);
  const stopStartRef = useRef<number | null>(null);
  const recordingStartRef = useRef<number | null>(null);
  
  // Recording timer state
  const [recordingElapsedMs, setRecordingElapsedMs] = useState(0);
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const lastTickMsRef = useRef<number | null>(null);

  /**
   * Convert Float32 audio samples to Int16 PCM
   */
  const float32ToInt16 = useCallback((float32Array: Float32Array): Int16Array => {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return int16Array;
  }, []);

  /**
   * Downsample audio to 16kHz
   */
  const downsample = useCallback((buffer: Float32Array, inputSampleRate: number): Float32Array => {
    if (inputSampleRate === TARGET_SAMPLE_RATE) {
      return buffer;
    }
    const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
    const newLength = Math.round(buffer.length / ratio);
    const result = new Float32Array(newLength);
    for (let i = 0; i < newLength; i++) {
      const srcIndex = Math.floor(i * ratio);
      result[i] = buffer[srcIndex];
    }
    return result;
  }, []);

  /**
   * Send buffered audio to relay
   */
  const sendAudioBuffer = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    if (pcmBufferRef.current.length === 0) return;
    
    // Merge all buffered PCM chunks
    const totalLength = pcmBufferRef.current.reduce((acc, buf) => acc + buf.length, 0);
    const merged = new Int16Array(totalLength);
    let offset = 0;
    for (const buf of pcmBufferRef.current) {
      merged.set(buf, offset);
      offset += buf.length;
    }
    pcmBufferRef.current = [];
    
    // Send as binary
    wsRef.current.send(merged.buffer);
    metricsRef.current.audioBytesSent += merged.byteLength;
  }, []);

  /**
   * Cleanup all resources
   */
  const cleanup = useCallback(() => {
    // Stop timer
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    lastTickMsRef.current = null;
    
    // Stop send interval
    if (sendIntervalRef.current) {
      clearInterval(sendIntervalRef.current);
      sendIntervalRef.current = null;
    }
    
    // Disconnect audio nodes
    if (processorNodeRef.current) {
      processorNodeRef.current.disconnect();
      processorNodeRef.current = null;
    }
    if (sourceNodeRef.current) {
      sourceNodeRef.current.disconnect();
      sourceNodeRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    
    // Stop media stream
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    
    // Close WebSocket
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    
    pcmBufferRef.current = [];
  }, []);

  /**
   * Start recording with Deepgram streaming
   */
  const startRecording = useCallback(async () => {
    if (status !== 'idle') {
      safeWarn('[DeepgramStream] Cannot start - not idle');
      return;
    }
    
    setStatus('connecting');
    setError(null);
    setTranscript('');
    accumulatedTranscriptRef.current = '';
    metricsRef.current = {
      stopToFinalTranscriptMs: null,
      audioBytesSent: 0,
      partialCount: 0,
      finalCount: 0,
      connectionTimeMs: null,
    };
    setRecordingElapsedMs(0);
    connectStartRef.current = Date.now();
    
    try {
      // Get Supabase access token
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      
      if (!accessToken) {
        throw new Error('No access token available');
      }
      
      // Connect to relay
      safeLog('[DeepgramStream] Connecting to relay...');
      const ws = new WebSocket(relayUrl);
      wsRef.current = ws;
      
      // Connection timeout (5 seconds)
      const connectionTimeout = setTimeout(() => {
        if (ws.readyState === WebSocket.CONNECTING) {
          safeErrorLog('[DeepgramStream] Connection timeout', new Error('timeout'));
          ws.close();
          setError('Connection timeout');
          setStatus('error');
          onError?.('Connection timeout');
        }
      }, 5000);
      
      ws.onopen = () => {
        safeLog('[DeepgramStream] WebSocket connected, authenticating...');
        ws.send(JSON.stringify({ type: 'auth', access_token: accessToken }));
      };
      
      ws.onmessage = async (event) => {
        try {
          const msg = JSON.parse(event.data);
          
          switch (msg.type) {
            case 'authenticated':
              safeLog('[DeepgramStream] Authenticated');
              break;
              
            case 'ready':
              clearTimeout(connectionTimeout);
              const connectionTime = Date.now() - (connectStartRef.current || Date.now());
              metricsRef.current.connectionTimeMs = connectionTime;
              safeLog(`[DeepgramStream] Ready in ${connectionTime}ms, starting audio capture`);
              
              // Start audio capture
              await startAudioCapture();
              break;
              
            case 'partial':
              metricsRef.current.partialCount++;
              onPartialTranscript?.(msg.text);
              break;
              
            case 'final':
              metricsRef.current.finalCount++;
              if (msg.text) {
                accumulatedTranscriptRef.current = accumulatedTranscriptRef.current
                  ? `${accumulatedTranscriptRef.current} ${msg.text}`
                  : msg.text;
                setTranscript(accumulatedTranscriptRef.current);
                onFinalTranscript?.(accumulatedTranscriptRef.current);
              }
              break;
              
            case 'utterance_end':
              // Can use for UI feedback
              break;
              
            case 'done':
              safeLog('[DeepgramStream] Session done', msg.stats);
              if (stopStartRef.current) {
                metricsRef.current.stopToFinalTranscriptMs = Date.now() - stopStartRef.current;
              }
              setMetrics({ ...metricsRef.current });
              cleanup();
              setStatus('done');
              break;
              
            case 'error':
              safeErrorLog('[DeepgramStream] Relay error:', msg.error);
              setError(msg.error);
              onError?.(msg.error);
              break;
          }
        } catch (err) {
          // Ignore parse errors
        }
      };
      
      ws.onerror = () => {
        safeErrorLog('[DeepgramStream] WebSocket error', new Error('ws error'));
        clearTimeout(connectionTimeout);
        cleanup();
        setError('Connection error');
        setStatus('error');
        onError?.('Connection error');
      };
      
      ws.onclose = (event) => {
        clearTimeout(connectionTimeout);
        safeLog(`[DeepgramStream] WebSocket closed: ${event.code}`);
      };
      
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Failed to start';
      safeErrorLog('[DeepgramStream] Start error:', errMsg);
      cleanup();
      setError(errMsg);
      setStatus('error');
      onError?.(errMsg);
    }
  }, [status, relayUrl, onPartialTranscript, onFinalTranscript, onError, cleanup]);

  /**
   * Start audio capture after WebSocket is ready
   */
  const startAudioCapture = async () => {
    try {
      // Get microphone
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;
      
      // Create audio context
      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      
      const inputSampleRate = audioContext.sampleRate;
      safeLog(`[DeepgramStream] Audio context: ${inputSampleRate}Hz`);
      
      // Create source and processor
      const sourceNode = audioContext.createMediaStreamSource(stream);
      sourceNodeRef.current = sourceNode;
      
      const processorNode = audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);
      processorNodeRef.current = processorNode;
      
      processorNode.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        const resampled = downsample(new Float32Array(inputData), inputSampleRate);
        const pcm16 = float32ToInt16(resampled);
        pcmBufferRef.current.push(pcm16);
      };
      
      sourceNode.connect(processorNode);
      processorNode.connect(audioContext.destination);
      
      // Start send interval
      sendIntervalRef.current = setInterval(sendAudioBuffer, SEND_INTERVAL_MS);
      
      // Start recording timer
      recordingStartRef.current = Date.now();
      lastTickMsRef.current = Date.now();
      timerIntervalRef.current = setInterval(() => {
        if (lastTickMsRef.current !== null) {
          const now = Date.now();
          const delta = now - lastTickMsRef.current;
          lastTickMsRef.current = now;
          setRecordingElapsedMs(prev => prev + delta);
        }
      }, 250);
      
      setStatus('recording');
      safeLog('[DeepgramStream] Recording started');
      
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Microphone access failed';
      safeErrorLog('[DeepgramStream] Audio capture error:', errMsg);
      throw new Error(errMsg);
    }
  };

  /**
   * Stop recording and get final transcript
   */
  const stopRecording = useCallback(async (): Promise<string> => {
    if (status !== 'recording' && status !== 'connecting') {
      safeWarn('[DeepgramStream] Cannot stop - not recording');
      return accumulatedTranscriptRef.current;
    }
    
    safeLog('[DeepgramStream] Stopping...');
    const currentTranscript = accumulatedTranscriptRef.current;
    setStatus('finalizing');
    stopStartRef.current = Date.now();
    
    // Stop timer
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    
    // Stop audio capture
    if (sendIntervalRef.current) {
      clearInterval(sendIntervalRef.current);
      sendIntervalRef.current = null;
    }
    
    // Send any remaining audio
    sendAudioBuffer();
    
    // Disconnect audio nodes
    if (processorNodeRef.current) {
      processorNodeRef.current.disconnect();
      processorNodeRef.current = null;
    }
    if (sourceNodeRef.current) {
      sourceNodeRef.current.disconnect();
      sourceNodeRef.current = null;
    }
    if (audioContextRef.current) {
      await audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    
    // Send stop command to relay
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'stop' }));
    }
    
    // Wait for 'done' message (with timeout)
    return new Promise((resolve) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          safeWarn('[DeepgramStream] Stop timeout, using current transcript');
          cleanup();
          setStatus('done');
          resolve(accumulatedTranscriptRef.current);
        }
      }, 3000);
      
      const checkDone = setInterval(() => {
        if (wsRef.current === null) {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            clearInterval(checkDone);
            resolve(accumulatedTranscriptRef.current);
          }
        }
      }, 100);
    });
  }, [status, sendAudioBuffer, cleanup]);

  /**
   * Reset to initial state
   */
  const reset = useCallback(() => {
    cleanup();
    setStatus('idle');
    setTranscript('');
    setError(null);
    setRecordingElapsedMs(0);
    accumulatedTranscriptRef.current = '';
    metricsRef.current = {
      stopToFinalTranscriptMs: null,
      audioBytesSent: 0,
      partialCount: 0,
      finalCount: 0,
      connectionTimeMs: null,
    };
    setMetrics(metricsRef.current);
  }, [cleanup]);

  return {
    status,
    transcript,
    error,
    metrics,
    recordingElapsedMs,
    startRecording,
    stopRecording,
    reset,
    isRecording: status === 'recording',
    isConnecting: status === 'connecting',
    isFinalizing: status === 'finalizing',
  };
}
