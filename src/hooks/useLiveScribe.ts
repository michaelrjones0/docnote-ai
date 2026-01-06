import { useState, useRef, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { LiveDraftMode } from './useDocNoteSession';
import { debugLog, debugLogPHI, safeLog, safeWarn, safeErrorLog } from '@/lib/debug';

export type LiveScribeStatus = 'idle' | 'recording' | 'paused' | 'finalizing' | 'done' | 'error';

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

// Encounter snapshot for future persistence/switching
export interface EncounterSnapshot {
  encounterId: string;
  status: LiveScribeStatus;
  elapsedMs: number;
  transcriptText: string;
  segmentsMeta: TranscriptSegment[];
  runningSummary: string | null;
  preferencesUsed: object;
  lastUpdatedAt: string;
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
  
  // Recording timer state - tracks ACTIVE recording time only (excludes paused time)
  const [recordingElapsedMs, setRecordingElapsedMs] = useState(0);
  const elapsedBeforePauseRef = useRef(0); // Accumulated time before pause
  const lastTickMsRef = useRef<number | null>(null); // When we last ticked the timer
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);
  
  // Encounter ID for future encounter switching
  const encounterIdRef = useRef<string>(crypto.randomUUID());
  
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

  // AbortController for in-flight chunk requests
  const chunkAbortControllerRef = useRef<AbortController | null>(null);

  // Retry helper with exponential backoff
  const fetchWithRetry = useCallback(async (
    url: string, 
    options: RequestInit, 
    maxRetries = 3
  ): Promise<Response> => {
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await fetch(url, options);
        
        // Don't retry 4xx errors (except 429)
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          return response;
        }
        
        // Retry on 5xx, 429, or network errors
        if (response.status >= 500 || response.status === 429) {
          safeWarn(`[LiveScribe] Retry attempt ${attempt + 1}/${maxRetries} after ${response.status}`);
          lastError = new Error(`HTTP ${response.status}`);
          
          if (attempt < maxRetries - 1) {
            // Exponential backoff: 1s, 2s, 4s
            const delay = Math.pow(2, attempt) * 1000;
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
        }
        
        return response;
      } catch (err) {
        // Network error or abort
        if (err instanceof DOMException && err.name === 'AbortError') {
          throw err; // Don't retry aborts
        }
        
        lastError = err instanceof Error ? err : new Error('Network error');
        safeWarn(`[LiveScribe] Retry attempt ${attempt + 1}/${maxRetries} after network error`);
        
        if (attempt < maxRetries - 1) {
          const delay = Math.pow(2, attempt) * 1000;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    throw lastError || new Error('Max retries exceeded');
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

      safeLog(`[LiveScribe] Sending PCM chunk ${chunkIndex}, samples: ${pcmData.length}, bytes: ${byteLength}`);

      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      
      if (!accessToken) {
        throw new Error('No access token available');
      }

      // Create new AbortController for this request
      chunkAbortControllerRef.current = new AbortController();

      const response = await fetchWithRetry(
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
          signal: chunkAbortControllerRef.current.signal,
        },
        3 // max retries
      );

      chunkAbortControllerRef.current = null;

      if (!response.ok) {
        const errData = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(errData.error || `HTTP ${response.status}`);
      }

      const result = await response.json();
      debugLogPHI(`[LiveScribe] Chunk ${chunkIndex} transcribed:`, result.text, 100);
      
      setDebugInfo(prev => ({
        ...prev,
        lastLiveStatus: 'received',
        lastLiveError: null,
        chunksWithNoTranscript: result.text ? prev.chunksWithNoTranscript : prev.chunksWithNoTranscript + 1,
      }));

      return result;
    } catch (err) {
      // Handle abort gracefully
      if (err instanceof DOMException && err.name === 'AbortError') {
        safeLog(`[LiveScribe] Chunk ${chunkIndex} request aborted (paused)`);
        return null;
      }
      
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      safeErrorLog(`[LiveScribe] Error processing chunk ${chunkIndex}:`, err);
      
      setDebugInfo(prev => ({
        ...prev,
        lastLiveStatus: 'error',
        lastLiveError: errMsg,
      }));
      
      throw err;
    }
  }, [fetchWithRetry]);

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
        debugLog('[LiveScribe] Chunk too short, skipping');
        isProcessingRef.current = false;
        return;
      }

      safeLog(`[LiveScribe] Processing chunk ${currentIndex}, ${pcm16.length} samples (${(pcm16.length / TARGET_SAMPLE_RATE).toFixed(1)}s)`);

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
      // Handle aborts gracefully - don't surface as error
      if (err instanceof DOMException && err.name === 'AbortError') {
        safeLog('[LiveScribe] Chunk processing aborted');
        isProcessingRef.current = false;
        return;
      }
      
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      safeErrorLog('[LiveScribe] Chunk processing failed:', err);
      
      // Surface as warning, not error - keep recording locally
      setDebugInfo(prev => ({
        ...prev,
        lastLiveError: `Network issue: ${errMsg} — still recording locally`,
      }));
      
      // Only surface to onError if it's a persistent failure
      // Don't block recording for transient network issues
      safeWarn('[LiveScribe] Continuing recording despite chunk upload failure');
    } finally {
      isProcessingRef.current = false;
    }
  }, [mergeBuffers, downsample, float32ToInt16, processAudioChunk, onTranscriptUpdate]);

  // Update running summary (Option B only) - with retry on transient errors
  const updateRunningSummary = useCallback(async (retryCount = 0) => {
    const fullTranscript = accumulatedTranscriptRef.current;
    const transcriptDelta = fullTranscript.slice(lastSummaryTranscriptLengthRef.current);
    
    // Skip if no meaningful delta (at least 50 chars of new content)
    if (!transcriptDelta.trim() || transcriptDelta.trim().length < 50) {
      debugLog('[LiveScribe] No meaningful transcript delta for summary, skipping. Delta length:', transcriptDelta.length);
      return;
    }

    const callTime = new Date().toISOString();
    setDebugInfo(prev => ({
      ...prev,
      lastSummaryCallAt: callTime,
      lastSummaryError: null,
    }));

    try {
      safeLog('[LiveScribe] Updating running summary, delta length:', transcriptDelta.length, 'retry:', retryCount);
      
      const { data, error: fnError } = await supabase.functions.invoke('update-visit-summary', {
        body: {
          transcriptDelta,
          runningSummary: currentRunningSummaryRef.current,
          preferences
        }
      });

      if (fnError) {
        const errorMsg = fnError.message || 'Summary update failed';
        safeErrorLog('[LiveScribe] Summary update error:', fnError);
        
        // Retry once on transient errors (504, 502, 500)
        if (retryCount === 0 && /timeout|502|504|500/i.test(errorMsg)) {
          safeLog('[LiveScribe] Retrying summary update after transient error...');
          setTimeout(() => updateRunningSummary(1), 2000);
          return;
        }
        
        setDebugInfo(prev => ({
          ...prev,
          lastSummaryError: errorMsg,
        }));
        // Don't throw - continue transcription without blocking
        return;
      }

      // Handle error responses from the function
      if (data?.error) {
        safeErrorLog('[LiveScribe] Summary function returned error:', data.error);
        setDebugInfo(prev => ({
          ...prev,
          lastSummaryError: data.error,
        }));
        return;
      }

      const summary = data?.runningSummary || data?.summary;
      if (summary) {
        currentRunningSummaryRef.current = summary;
        setRunningSummary(summary);
        onSummaryUpdate?.(summary);
        lastSummaryTranscriptLengthRef.current = fullTranscript.length;
        safeLog('[LiveScribe] Summary updated successfully, length:', summary.length);
      } else {
        safeWarn('[LiveScribe] No summary in response:', Object.keys(data || {}));
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      safeErrorLog('[LiveScribe] Summary update failed:', err);
      
      // Retry once on network errors
      if (retryCount === 0) {
        safeLog('[LiveScribe] Retrying summary update after error...');
        setTimeout(() => updateRunningSummary(1), 2000);
        return;
      }
      
      setDebugInfo(prev => ({
        ...prev,
        lastSummaryError: errMsg,
      }));
      // Don't throw - continue transcription without blocking
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
      safeLog(`[LiveScribe] Audio context sample rate: ${inputSampleRate} Hz`);
      
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

      // Set up summary interval for Option B (every 30 seconds, configurable)
      if (liveDraftMode === 'B') {
        const summaryIntervalMs = 30000; // 30 seconds - can be made configurable
        safeLog(`[LiveScribe] Setting up summary interval: ${summaryIntervalMs}ms`);
        summaryIntervalRef.current = setInterval(() => {
          // Only call if we have meaningful new content (50+ chars since last summary)
          if (accumulatedTranscriptRef.current.length > lastSummaryTranscriptLengthRef.current + 50) {
            updateRunningSummary();
          }
        }, 75000);
      }

      // Start the recording timer
      elapsedBeforePauseRef.current = 0;
      lastTickMsRef.current = Date.now();
      setRecordingElapsedMs(0);
      timerIntervalRef.current = setInterval(() => {
        if (lastTickMsRef.current !== null) {
          const now = Date.now();
          const delta = now - lastTickMsRef.current;
          lastTickMsRef.current = now;
          setRecordingElapsedMs(prev => prev + delta);
        }
      }, 250);

      setStatus('recording');
      safeLog('[LiveScribe] Recording started with PCM capture, mode:', liveDraftMode);
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
    // Can stop from recording or paused state
    if (status !== 'recording' && status !== 'paused') {
      debugLog('[LiveScribe] Cannot stop - not recording or paused, status:', status);
      return accumulatedTranscriptRef.current;
    }
    
    safeLog('[LiveScribe] Stopping recording from status:', status);
    setStatus('finalizing');

    // Stop the recording timer (freeze elapsed time)
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }

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
        safeErrorLog('[LiveScribe] Error processing final chunks:', err);
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
    safeLog('[LiveScribe] Recording stopped, transcript length:', finalTranscript.length);

    return finalTranscript;
  }, [status, sendCurrentChunks, liveDraftMode, updateRunningSummary]);

  // Pause recording: stop audio capture but preserve state
  const pauseRecording = useCallback(() => {
    if (status !== 'recording') {
      debugLog('[LiveScribe] Cannot pause - not recording, status:', status);
      return;
    }
    
    safeLog('[LiveScribe] Pausing recording...');
    
    // Abort any in-flight chunk request
    if (chunkAbortControllerRef.current) {
      chunkAbortControllerRef.current.abort();
      chunkAbortControllerRef.current = null;
    }
    
    // Stop timer (freeze elapsed time)
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    // Store current elapsed time for resume
    elapsedBeforePauseRef.current = recordingElapsedMs;
    lastTickMsRef.current = null;
    
    // Stop audio processing interval
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    
    // Stop summary updates (Option B)
    if (summaryIntervalRef.current) {
      clearInterval(summaryIntervalRef.current);
      summaryIntervalRef.current = null;
    }
    
    // Disconnect audio nodes (stop capturing) but keep refs for resume
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
    
    // Stop media stream tracks
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    
    // Clear PCM buffer (already sent chunks are fine)
    pcmBufferRef.current = [];
    isProcessingRef.current = false;
    
    setStatus('paused');
    safeLog('[LiveScribe] Recording paused, elapsed:', recordingElapsedMs, 'ms');
  }, [status, recordingElapsedMs]);

  // Resume recording: restart audio capture, continue appending to transcript
  const resumeRecording = useCallback(async () => {
    if (status !== 'paused') {
      debugLog('[LiveScribe] Cannot resume - not paused, status:', status);
      return;
    }
    
    safeLog('[LiveScribe] Resuming recording...');
    
    try {
      // Re-acquire microphone
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      
      streamRef.current = stream;
      
      // Create new audio context
      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      
      const inputSampleRate = audioContext.sampleRate;
      safeLog(`[LiveScribe] Resume - Audio context sample rate: ${inputSampleRate} Hz`);
      
      setDebugInfo(prev => ({
        ...prev,
        inputSampleRate,
      }));
      
      // Create source node from stream
      const sourceNode = audioContext.createMediaStreamSource(stream);
      sourceNodeRef.current = sourceNode;
      
      // Create script processor for capturing PCM data
      const processorNode = audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);
      processorNodeRef.current = processorNode;
      
      processorNode.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        const pcmData = new Float32Array(inputData.length);
        pcmData.set(inputData);
        pcmBufferRef.current.push(pcmData);
      };
      
      // Connect nodes
      sourceNode.connect(processorNode);
      processorNode.connect(audioContext.destination);
      
      // Restart audio processing interval
      intervalRef.current = setInterval(() => {
        sendCurrentChunks();
      }, chunkIntervalMs);
      
      // Restart summary interval for Option B
      if (liveDraftMode === 'B') {
        safeLog('[LiveScribe] Resume - Restarting summary interval');
        summaryIntervalRef.current = setInterval(() => {
          if (accumulatedTranscriptRef.current.length > lastSummaryTranscriptLengthRef.current + 50) {
            updateRunningSummary();
          }
        }, 75000);
        
        // Optional: trigger immediate summary update on resume
        if (accumulatedTranscriptRef.current.length > lastSummaryTranscriptLengthRef.current + 50) {
          updateRunningSummary();
        }
      }
      
      // Resume timer from where we left off
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
      safeLog('[LiveScribe] Recording resumed, continuing from elapsed:', recordingElapsedMs, 'ms');
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Failed to resume microphone access';
      safeErrorLog('[LiveScribe] Resume failed:', err);
      setError(errMsg);
      // Stay in paused state rather than erroring out completely
      onError?.(errMsg);
    }
  }, [status, recordingElapsedMs, chunkIntervalMs, sendCurrentChunks, liveDraftMode, updateRunningSummary, onError]);

  // Get current encounter snapshot (for future persistence)
  const getEncounterSnapshot = useCallback((): EncounterSnapshot => {
    return {
      encounterId: encounterIdRef.current,
      status,
      elapsedMs: recordingElapsedMs,
      transcriptText: accumulatedTranscriptRef.current,
      segmentsMeta: segments,
      runningSummary: currentRunningSummaryRef.current,
      preferencesUsed: preferences,
      lastUpdatedAt: new Date().toISOString(),
    };
  }, [status, recordingElapsedMs, segments, preferences]);

  const reset = useCallback(() => {
    // Clear timer
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    elapsedBeforePauseRef.current = 0;
    lastTickMsRef.current = null;
    setRecordingElapsedMs(0);
    
    // Generate new encounter ID for next session
    encounterIdRef.current = crypto.randomUUID();

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
    recordingElapsedMs,
    encounterId: encounterIdRef.current,
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording,
    reset,
    getEncounterSnapshot,
  };
}
