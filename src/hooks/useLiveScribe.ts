import { useState, useRef, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { LiveDraftMode } from './useDocNoteSession';

export type LiveScribeStatus = 'idle' | 'recording' | 'finalizing' | 'done' | 'error';

interface TranscriptSegment {
  content: string;
  speaker: string;
  startMs: number;
  endMs: number;
}

export interface LiveScribeDebugInfo {
  lastLiveCallAt: string | null;
  lastLiveStatus: 'idle' | 'calling' | 'received' | 'error';
  lastLiveError: string | null;
  lastSummaryCallAt: string | null;
  lastSummaryError: string | null;
  chunksSent: number;
  totalTranscriptLength: number;
  // New PCM debug info
  inputSampleRate: number | null;
  outputSampleRate: number;
  chunkDurationMs: number;
  bytesPerChunk: number | null;
  encoding: string;
  chunksWithNoTranscript: number;
}

interface UseLiveScribeOptions {
  onTranscriptUpdate?: (transcript: string, segments: TranscriptSegment[]) => void;
  onSummaryUpdate?: (summary: string) => void;
  onError?: (error: string) => void;
  chunkIntervalMs?: number;
  liveDraftMode?: LiveDraftMode;
  preferences?: object;
}

// PCM audio capture constants
const TARGET_SAMPLE_RATE = 16000;
const CHUNK_DURATION_MS = 5000; // 5 second chunks for better transcription
const BUFFER_SIZE = 4096; // ScriptProcessor buffer size

export function useLiveScribe(options: UseLiveScribeOptions = {}) {
  const { 
    onTranscriptUpdate, 
    onSummaryUpdate,
    onError, 
    chunkIntervalMs = CHUNK_DURATION_MS,
    liveDraftMode = 'A',
    preferences = {}
  } = options;
  
  const [status, setStatus] = useState<LiveScribeStatus>('idle');
  const [transcript, setTranscript] = useState('');
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [runningSummary, setRunningSummary] = useState<string | null>(null);
  
  // Debug state
  const [debugInfo, setDebugInfo] = useState<LiveScribeDebugInfo>({
    lastLiveCallAt: null,
    lastLiveStatus: 'idle',
    lastLiveError: null,
    lastSummaryCallAt: null,
    lastSummaryError: null,
    chunksSent: 0,
    totalTranscriptLength: 0,
    inputSampleRate: null,
    outputSampleRate: TARGET_SAMPLE_RATE,
    chunkDurationMs: chunkIntervalMs,
    bytesPerChunk: null,
    encoding: 'pcm16le',
    chunksWithNoTranscript: 0,
  });

  // Audio context and nodes
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorNodeRef = useRef<ScriptProcessorNode | null>(null);
  
  // PCM buffer
  const pcmBufferRef = useRef<Float32Array[]>([]);
  const chunkIndexRef = useRef(0);
  const isProcessingRef = useRef(false);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  
  // Accumulated transcript for proper delta calculation
  const accumulatedTranscriptRef = useRef('');
  
  // For running summary (Option B)
  const lastSummaryTranscriptLengthRef = useRef(0);
  const summaryIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const currentRunningSummaryRef = useRef<string | null>(null);

  // Convert Float32 samples to Int16 PCM (little-endian)
  const float32ToInt16 = useCallback((float32Array: Float32Array): Int16Array => {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      // Clamp and convert
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return int16Array;
  }, []);

  // Downsample audio to target sample rate
  const downsample = useCallback((buffer: Float32Array, inputSampleRate: number, outputSampleRate: number): Float32Array => {
    if (inputSampleRate === outputSampleRate) {
      return buffer;
    }
    
    const ratio = inputSampleRate / outputSampleRate;
    const newLength = Math.round(buffer.length / ratio);
    const result = new Float32Array(newLength);
    
    for (let i = 0; i < newLength; i++) {
      const srcIndex = Math.floor(i * ratio);
      result[i] = buffer[srcIndex];
    }
    
    return result;
  }, []);

  // Merge all buffered PCM samples into one array
  const mergeBuffers = useCallback((buffers: Float32Array[]): Float32Array => {
    const totalLength = buffers.reduce((acc, buf) => acc + buf.length, 0);
    const result = new Float32Array(totalLength);
    let offset = 0;
    for (const buf of buffers) {
      result.set(buf, offset);
      offset += buf.length;
    }
    return result;
  }, []);

  const processAudioChunk = useCallback(async (pcmData: Int16Array, chunkIndex: number): Promise<{ text: string; segments: TranscriptSegment[] } | null> => {
    const callTime = new Date().toISOString();
    const byteLength = pcmData.byteLength;
    
    setDebugInfo(prev => ({
      ...prev,
      lastLiveCallAt: callTime,
      lastLiveStatus: 'calling',
      lastLiveError: null,
      chunksSent: prev.chunksSent + 1,
      bytesPerChunk: byteLength,
    }));
    
    try {
      // Convert Int16Array to base64
      const uint8Array = new Uint8Array(pcmData.buffer);
      let binary = '';
      const chunkSize = 0x8000;
      for (let i = 0; i < uint8Array.length; i += chunkSize) {
        const chunk = uint8Array.subarray(i, Math.min(i + chunkSize, uint8Array.length));
        binary += String.fromCharCode.apply(null, Array.from(chunk));
      }
      const base64Audio = btoa(binary);

      console.log(`[LiveScribe] Sending PCM chunk ${chunkIndex}, samples: ${pcmData.length}, bytes: ${byteLength}`);

      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      
      if (!accessToken) {
        throw new Error('No access token available');
      }

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/transcribe-audio-live`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            audio: base64Audio,
            encoding: 'pcm',
            sampleRate: TARGET_SAMPLE_RATE,
            languageCode: 'en-US',
            chunkIndex,
          }),
        }
      );

      if (!response.ok) {
        const errData = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(errData.error || `HTTP ${response.status}`);
      }

      const result = await response.json();
      console.log(`[LiveScribe] Chunk ${chunkIndex} transcribed:`, result.text?.slice(0, 100));
      
      setDebugInfo(prev => ({
        ...prev,
        lastLiveStatus: 'received',
        lastLiveError: null,
        chunksWithNoTranscript: result.text ? prev.chunksWithNoTranscript : prev.chunksWithNoTranscript + 1,
      }));

      return result;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[LiveScribe] Error processing chunk ${chunkIndex}:`, err);
      
      setDebugInfo(prev => ({
        ...prev,
        lastLiveStatus: 'error',
        lastLiveError: errMsg,
      }));
      
      throw err;
    }
  }, []);

  const sendCurrentChunks = useCallback(async () => {
    if (isProcessingRef.current || pcmBufferRef.current.length === 0) {
      return;
    }

    isProcessingRef.current = true;
    const buffersToProcess = [...pcmBufferRef.current];
    pcmBufferRef.current = [];
    const currentIndex = chunkIndexRef.current++;

    try {
      // Merge all float32 buffers
      const mergedFloat32 = mergeBuffers(buffersToProcess);
      
      // Downsample if needed
      const inputSampleRate = audioContextRef.current?.sampleRate || 48000;
      const resampled = downsample(mergedFloat32, inputSampleRate, TARGET_SAMPLE_RATE);
      
      // Convert to Int16
      const pcm16 = float32ToInt16(resampled);
      
      // Skip if too short (less than 0.5 seconds of audio)
      if (pcm16.length < TARGET_SAMPLE_RATE * 0.5) {
        console.log('[LiveScribe] Chunk too short, skipping');
        isProcessingRef.current = false;
        return;
      }

      console.log(`[LiveScribe] Processing chunk ${currentIndex}, ${pcm16.length} samples (${(pcm16.length / TARGET_SAMPLE_RATE).toFixed(1)}s)`);

      const result = await processAudioChunk(pcm16, currentIndex);
      
      if (result?.text) {
        const newText = result.text.trim();
        if (newText) {
          accumulatedTranscriptRef.current = accumulatedTranscriptRef.current
            ? `${accumulatedTranscriptRef.current} ${newText}`
            : newText;
          
          const fullTranscript = accumulatedTranscriptRef.current;
          
          setSegments(prev => {
            const newSegments = [...prev, ...(result.segments || [])];
            return newSegments;
          });
          
          setTranscript(fullTranscript);
          
          setDebugInfo(prev => ({
            ...prev,
            totalTranscriptLength: fullTranscript.length,
          }));
          
          // Call the callback to update session.transcriptText
          onTranscriptUpdate?.(fullTranscript, result.segments || []);
        }
      }
      
      // Check for early failure: if first 3 chunks return no text, surface error
      if (currentIndex >= 2) {
        setDebugInfo(prev => {
          if (prev.chunksWithNoTranscript >= 3 && prev.totalTranscriptLength === 0) {
            const errMsg = 'No transcript received after 3 chunks - check microphone and audio levels';
            setError(errMsg);
            onError?.(errMsg);
          }
          return prev;
        });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      console.error('[LiveScribe] Chunk processing failed:', errMsg);
      setError(errMsg);
      onError?.(errMsg);
    } finally {
      isProcessingRef.current = false;
    }
  }, [mergeBuffers, downsample, float32ToInt16, processAudioChunk, onTranscriptUpdate, onError]);

  // Update running summary (Option B only)
  const updateRunningSummary = useCallback(async () => {
    const fullTranscript = accumulatedTranscriptRef.current;
    const transcriptDelta = fullTranscript.slice(lastSummaryTranscriptLengthRef.current);
    
    if (!transcriptDelta.trim()) {
      console.log('[LiveScribe] No new transcript delta for summary, skipping');
      return;
    }

    const callTime = new Date().toISOString();
    setDebugInfo(prev => ({
      ...prev,
      lastSummaryCallAt: callTime,
      lastSummaryError: null,
    }));

    try {
      console.log('[LiveScribe] Updating running summary, delta length:', transcriptDelta.length);
      
      const { data, error: fnError } = await supabase.functions.invoke('update-visit-summary', {
        body: {
          transcriptDelta,
          runningSummary: currentRunningSummaryRef.current,
          preferences
        }
      });

      if (fnError) {
        console.error('[LiveScribe] Summary update error:', fnError);
        setDebugInfo(prev => ({
          ...prev,
          lastSummaryError: fnError.message || 'Summary update failed',
        }));
        return;
      }

      if (data?.runningSummary) {
        currentRunningSummaryRef.current = data.runningSummary;
        setRunningSummary(data.runningSummary);
        onSummaryUpdate?.(data.runningSummary);
        lastSummaryTranscriptLengthRef.current = fullTranscript.length;
        console.log('[LiveScribe] Summary updated successfully');
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      console.error('[LiveScribe] Summary update failed:', err);
      setDebugInfo(prev => ({
        ...prev,
        lastSummaryError: errMsg,
      }));
    }
  }, [preferences, onSummaryUpdate]);

  const startRecording = useCallback(async () => {
    try {
      setError(null);
      setTranscript('');
      setSegments([]);
      setRunningSummary(null);
      chunkIndexRef.current = 0;
      pcmBufferRef.current = [];
      accumulatedTranscriptRef.current = '';
      lastSummaryTranscriptLengthRef.current = 0;
      currentRunningSummaryRef.current = null;
      
      setDebugInfo({
        lastLiveCallAt: null,
        lastLiveStatus: 'idle',
        lastLiveError: null,
        lastSummaryCallAt: null,
        lastSummaryError: null,
        chunksSent: 0,
        totalTranscriptLength: 0,
        inputSampleRate: null,
        outputSampleRate: TARGET_SAMPLE_RATE,
        chunkDurationMs: chunkIntervalMs,
        bytesPerChunk: null,
        encoding: 'pcm16le',
        chunksWithNoTranscript: 0,
      });

      // Get microphone stream
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
      console.log(`[LiveScribe] Audio context sample rate: ${inputSampleRate} Hz`);
      
      setDebugInfo(prev => ({
        ...prev,
        inputSampleRate,
      }));

      // Create source node from stream
      const sourceNode = audioContext.createMediaStreamSource(stream);
      sourceNodeRef.current = sourceNode;

      // Create script processor for capturing PCM data
      // Note: ScriptProcessorNode is deprecated but AudioWorklet requires more setup
      const processorNode = audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);
      processorNodeRef.current = processorNode;

      processorNode.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        // Clone the data since the buffer will be reused
        const pcmData = new Float32Array(inputData.length);
        pcmData.set(inputData);
        pcmBufferRef.current.push(pcmData);
      };

      // Connect nodes
      sourceNode.connect(processorNode);
      processorNode.connect(audioContext.destination);

      // Set up interval to send chunks periodically
      intervalRef.current = setInterval(() => {
        sendCurrentChunks();
      }, chunkIntervalMs);

      // Set up summary interval for Option B (every 75 seconds)
      if (liveDraftMode === 'B') {
        summaryIntervalRef.current = setInterval(() => {
          if (accumulatedTranscriptRef.current.length > lastSummaryTranscriptLengthRef.current + 50) {
            updateRunningSummary();
          }
        }, 75000);
      }

      setStatus('recording');
      console.log('[LiveScribe] Recording started with PCM capture, mode:', liveDraftMode);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Failed to access microphone';
      setError(errMsg);
      setStatus('error');
      setDebugInfo(prev => ({
        ...prev,
        lastLiveError: errMsg,
        lastLiveStatus: 'error',
      }));
      onError?.(errMsg);
    }
  }, [chunkIntervalMs, sendCurrentChunks, onError, liveDraftMode, updateRunningSummary]);

  const stopRecording = useCallback(async (): Promise<string> => {
    console.log('[LiveScribe] Stopping recording...');
    setStatus('finalizing');

    // Clear intervals
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (summaryIntervalRef.current) {
      clearInterval(summaryIntervalRef.current);
      summaryIntervalRef.current = null;
    }

    // Disconnect and close audio nodes
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

    // Stop all tracks
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }

    // Process any remaining buffered audio
    if (pcmBufferRef.current.length > 0) {
      try {
        await sendCurrentChunks();
      } catch (err) {
        console.error('[LiveScribe] Error processing final chunks:', err);
      }
    }

    // Wait for any in-progress processing to complete
    let waitAttempts = 0;
    while (isProcessingRef.current && waitAttempts < 30) {
      await new Promise(resolve => setTimeout(resolve, 500));
      waitAttempts++;
    }

    // Get final transcript from ref (more reliable than state)
    const finalTranscript = accumulatedTranscriptRef.current;

    // Final summary update for Option B
    if (liveDraftMode === 'B' && finalTranscript.length > lastSummaryTranscriptLengthRef.current) {
      await updateRunningSummary();
    }

    setStatus('done');
    console.log('[LiveScribe] Recording stopped, transcript length:', finalTranscript.length);

    return finalTranscript;
  }, [sendCurrentChunks, liveDraftMode, updateRunningSummary]);

  const reset = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (summaryIntervalRef.current) {
      clearInterval(summaryIntervalRef.current);
      summaryIntervalRef.current = null;
    }
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
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    pcmBufferRef.current = [];
    chunkIndexRef.current = 0;
    isProcessingRef.current = false;
    accumulatedTranscriptRef.current = '';
    lastSummaryTranscriptLengthRef.current = 0;
    currentRunningSummaryRef.current = null;
    setStatus('idle');
    setTranscript('');
    setSegments([]);
    setError(null);
    setRunningSummary(null);
    setDebugInfo({
      lastLiveCallAt: null,
      lastLiveStatus: 'idle',
      lastLiveError: null,
      lastSummaryCallAt: null,
      lastSummaryError: null,
      chunksSent: 0,
      totalTranscriptLength: 0,
      inputSampleRate: null,
      outputSampleRate: TARGET_SAMPLE_RATE,
      chunkDurationMs: chunkIntervalMs,
      bytesPerChunk: null,
      encoding: 'pcm16le',
      chunksWithNoTranscript: 0,
    });
  }, [chunkIntervalMs]);

  return {
    status,
    transcript,
    segments,
    error,
    runningSummary,
    debugInfo,
    startRecording,
    stopRecording,
    reset,
  };
}
