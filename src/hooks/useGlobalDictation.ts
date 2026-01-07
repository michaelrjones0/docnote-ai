/**
 * useGlobalDictation - Global continuous dictation hook with AudioWorklet PCM capture.
 * 
 * Architecture:
 * - AudioWorklet captures raw PCM frames directly (no MediaRecorder)
 * - Downsamples to 16kHz mono PCM16 in main thread
 * - Buffers ~700-900ms, wraps in WAV header, sends to transcribe-audio-live
 * - Non-overlapping batches eliminate duplicate text
 * 
 * ============================================================================
 * DICTATION SMOKE TEST CHECKLIST:
 * ============================================================================
 * 1. Toggle global mic → speak → text appears in focused field.
 * 2. Switch focus to another field while mic is on → text goes to new field.
 * 3. Click in middle of existing text, dictate → insertion at cursor.
 * 4. No console/network logs include transcript text or base64 audio.
 * 5. If no field focused, toast "Click into a field to dictate."
 * ============================================================================
 * 
 * PHI-SAFE: No transcript content logged. Only timing/status diagnostics.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useDictationContext } from '@/contexts/DictationContext';
import { safeErrorLog, safeLog } from '@/lib/debug';

// ============================================================================
// DEBUG FLAG - set to true to enable PHI-safe audio diagnostics
// ============================================================================
const DEBUG_AUDIO = true;

export type GlobalDictationStatus = 'idle' | 'listening' | 'transcribing';

// Instant dictation tuning constants
const TARGET_SAMPLE_RATE = 16000;     // Output sample rate for transcription
const TARGET_DURATION_MS = 800;       // Target audio duration per batch (~800ms)
const MIN_SAMPLES = TARGET_SAMPLE_RATE * 0.5; // Minimum samples (~500ms = 8000 samples)
const TAIL_DEDUP_CHARS = 40;          // Keep last N chars for text-based dedup

// Queued batch type: WAV bytes ready to send
interface QueuedBatch {
  wavBase64: string;
  durationMs: number;
  sessionId: number;
  peak: number;
}

interface UseGlobalDictationOptions {
  onError?: (error: string) => void;
  onNoFieldFocused?: () => void;
}

// AudioWorklet processor code as inline module
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
        // Send buffer to main thread
        this.port.postMessage({ pcmData: this.buffer.slice() });
        this.bufferIndex = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
`;

export function useGlobalDictation({
  onError,
  onNoFieldFocused,
}: UseGlobalDictationOptions = {}) {
  const { insertText, getActiveField, setIsDictating, activeFieldId } = useDictationContext();
  
  const [status, setStatus] = useState<GlobalDictationStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  // Audio pipeline refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  
  // PCM buffer (accumulated samples at source sample rate, will be resampled)
  const pcmBufferRef = useRef<Float32Array[]>([]);
  const sourceSampleRateRef = useRef<number>(48000); // Will be set from AudioContext
  
  // FIFO send queue - batches ready to send (WAV base64)
  const sendQueueRef = useRef<QueuedBatch[]>([]);
  
  // Processing state
  const isProcessingRef = useRef(false);
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastInsertedTailRef = useRef<string>(''); // Last N chars inserted for text dedup
  const recordingStartTimeRef = useRef<number>(0);
  const lastBatchTimeRef = useRef<number>(0);
  const isActiveRef = useRef(false); // Track if dictation is active
  
  // Session management refs for reliable flush
  const isStoppingRef = useRef(false);
  const activeFieldIdAtStartRef = useRef<string | null>(null);
  const sessionIdRef = useRef(0);

  // Cleanup function
  const cleanup = useCallback(() => {
    isActiveRef.current = false;
    isStoppingRef.current = false;
    
    if (batchTimerRef.current) {
      clearTimeout(batchTimerRef.current);
      batchTimerRef.current = null;
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
    sendQueueRef.current = [];
    lastInsertedTailRef.current = '';
    recordingStartTimeRef.current = 0;
    lastBatchTimeRef.current = 0;
    isProcessingRef.current = false;
    activeFieldIdAtStartRef.current = null;
    setIsDictating(false);
  }, [setIsDictating]);

  // Resample Float32 array from source rate to target rate (simple linear interpolation)
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

  // Convert Float32 to PCM16 Int16Array
  const floatToPCM16 = useCallback((floatData: Float32Array): Int16Array => {
    const pcm16 = new Int16Array(floatData.length);
    for (let i = 0; i < floatData.length; i++) {
      const s = Math.max(-1, Math.min(1, floatData[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return pcm16;
  }, []);

  // Create WAV file from PCM16 data
  const createWavFile = useCallback((pcm16: Int16Array): Uint8Array => {
    const sampleRate = TARGET_SAMPLE_RATE;
    const channels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    const blockAlign = channels * (bitsPerSample / 8);
    const dataBytes = pcm16.length * 2;
    const headerSize = 44;
    
    const buffer = new ArrayBuffer(headerSize + dataBytes);
    const view = new DataView(buffer);
    
    // RIFF header
    view.setUint8(0, 0x52); view.setUint8(1, 0x49); view.setUint8(2, 0x46); view.setUint8(3, 0x46);
    view.setUint32(4, 36 + dataBytes, true);
    view.setUint8(8, 0x57); view.setUint8(9, 0x41); view.setUint8(10, 0x56); view.setUint8(11, 0x45);
    
    // fmt chunk
    view.setUint8(12, 0x66); view.setUint8(13, 0x6D); view.setUint8(14, 0x74); view.setUint8(15, 0x20);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    
    // data chunk
    view.setUint8(36, 0x64); view.setUint8(37, 0x61); view.setUint8(38, 0x74); view.setUint8(39, 0x61);
    view.setUint32(40, dataBytes, true);
    
    // Copy PCM data
    new Uint8Array(buffer).set(new Uint8Array(pcm16.buffer), headerSize);
    
    return new Uint8Array(buffer);
  }, []);

  // Convert Uint8Array to base64
  const uint8ArrayToBase64 = useCallback((bytes: Uint8Array): string => {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
      binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
    }
    return btoa(binary);
  }, []);

  // Move pending PCM chunks to send queue as a prepared batch
  const enqueueBatch = useCallback((options?: { force?: boolean }) => {
    const force = options?.force ?? false;
    
    if (pcmBufferRef.current.length === 0) return false;
    
    const totalSamples = pcmBufferRef.current.reduce((sum, arr) => sum + arr.length, 0);
    const sourceSampleRate = sourceSampleRateRef.current;
    const expectedSamplesFor16k = (totalSamples / sourceSampleRate) * TARGET_SAMPLE_RATE;
    
    const now = Date.now();
    const elapsedMs = lastBatchTimeRef.current > 0 
      ? now - lastBatchTimeRef.current 
      : now - recordingStartTimeRef.current;
    
    // Check if we have enough audio (skip check if force)
    if (!force && expectedSamplesFor16k < MIN_SAMPLES && elapsedMs < TARGET_DURATION_MS) {
      return false;
    }
    
    // CONSUME buffer - move to queue
    const bufferedChunks = pcmBufferRef.current;
    pcmBufferRef.current = [];
    lastBatchTimeRef.current = now;
    
    // Combine all chunks into single Float32Array
    const combinedSamples = new Float32Array(totalSamples);
    let offset = 0;
    for (const chunk of bufferedChunks) {
      combinedSamples.set(chunk, offset);
      offset += chunk.length;
    }
    
    // Check for silence
    let peak = 0;
    for (let i = 0; i < combinedSamples.length; i++) {
      const v = Math.abs(combinedSamples[i]);
      if (v > peak) peak = v;
    }
    
    if (peak < 0.01) {
      if (DEBUG_AUDIO) {
        console.log('[GlobalDictation] near-silence, skipping enqueue', { peak: peak.toFixed(6), samples: totalSamples });
      }
      return false;
    }
    
    // Resample to 16kHz mono
    const resampled = resampleToMono16k(combinedSamples, sourceSampleRate);
    
    // Convert to PCM16
    const pcm16 = floatToPCM16(resampled);
    
    // Create WAV file
    const wavBytes = createWavFile(pcm16);
    const wavBase64 = uint8ArrayToBase64(wavBytes);
    
    const durationMs = (resampled.length / TARGET_SAMPLE_RATE) * 1000;
    
    // Add to FIFO queue
    const batch: QueuedBatch = {
      wavBase64,
      durationMs,
      sessionId: sessionIdRef.current,
      peak,
    };
    sendQueueRef.current.push(batch);
    
    if (DEBUG_AUDIO) {
      console.log('[GlobalDictation] enqueueBatch', {
        pendingChunksCount: pcmBufferRef.current.length,
        sendQueueLen: sendQueueRef.current.length,
        isProcessing: isProcessingRef.current,
        isStopping: isStoppingRef.current,
        durationMs: durationMs.toFixed(0),
        wavBytes: wavBytes.length,
      });
    }
    
    return true;
  }, [resampleToMono16k, floatToPCM16, createWavFile, uint8ArrayToBase64]);

  // Process one batch from send queue - FIFO
  const processQueue = useCallback(async (): Promise<void> => {
    // Already processing - queue will continue after current completes
    if (isProcessingRef.current) return;
    
    // Nothing to send
    if (sendQueueRef.current.length === 0) return;
    
    const activeField = getActiveField();
    if (!activeField && !isStoppingRef.current) {
      // No active field and not stopping - clear queue
      sendQueueRef.current = [];
      safeLog('[GlobalDictation] No active field, clearing send queue');
      onNoFieldFocused?.();
      return;
    }
    
    // DEQUEUE first batch (FIFO)
    const batch = sendQueueRef.current.shift()!;
    isProcessingRef.current = true;
    setStatus('transcribing');
    
    if (DEBUG_AUDIO) {
      console.log('[GlobalDictation] processQueue sending', {
        sendQueueLen: sendQueueRef.current.length,
        pendingChunksCount: pcmBufferRef.current.length,
        isProcessing: true,
        isStopping: isStoppingRef.current,
        durationMs: batch.durationMs.toFixed(0),
        sessionId: batch.sessionId,
      });
    }
    
    try {
      const startTime = Date.now();
      
      const { data, error: fnError } = await supabase.functions.invoke('transcribe-audio-live', {
        body: {
          audio: batch.wavBase64,
          chunkIndex: 0,
          mimeType: 'audio/wav',
          sampleRate: TARGET_SAMPLE_RATE,
          encoding: 'pcm16',
          debug: DEBUG_AUDIO,
        },
      });
      
      if (DEBUG_AUDIO) {
        console.log('[GlobalDictation] response meta', { 
          textLen: data?.meta?.textLen ?? (data?.text?.trim()?.length ?? 0), 
          segmentsLen: data?.meta?.segmentsLen ?? (data?.segments?.length ?? 0),
          latencyMs: Date.now() - startTime,
        });
      }
      
      if (fnError) throw fnError;
      
      // Session validation: only insert if session matches
      if (batch.sessionId !== sessionIdRef.current) {
        if (DEBUG_AUDIO) {
          console.log('[GlobalDictation] session mismatch, discarding result', {
            batchSession: batch.sessionId,
            currentSession: sessionIdRef.current,
          });
        }
        return;
      }
      
      // Get full text from response (no segment filtering - each batch is independent)
      const fullText = (data?.text || '').trim();
      
      if (DEBUG_AUDIO) {
        console.log('[GlobalDictation] batchRespMeta', {
          textLen: fullText.length,
          isStopping: isStoppingRef.current,
          sendQueueLen: sendQueueRef.current.length,
          pendingChunksCount: pcmBufferRef.current.length,
        });
      }
      
      if (!fullText) return;
      
      // Text-based dedup: trim any prefix overlap with last inserted tail
      let textToInsert = fullText;
      const tail = lastInsertedTailRef.current;
      
      if (tail.length > 0) {
        // Find longest suffix of tail that matches prefix of new text
        const maxCheck = Math.min(tail.length, fullText.length);
        let overlapLen = 0;
        
        for (let len = 1; len <= maxCheck; len++) {
          const tailSuffix = tail.slice(-len).toLowerCase();
          const textPrefix = fullText.slice(0, len).toLowerCase();
          if (tailSuffix === textPrefix) {
            overlapLen = len;
          }
        }
        
        if (overlapLen > 0) {
          textToInsert = fullText.slice(overlapLen).trimStart();
          if (DEBUG_AUDIO) {
            console.log('[GlobalDictation] trimmed overlap', { overlapLen, originalLen: fullText.length });
          }
        }
      }
      
      // Insert text and update tail
      if (textToInsert) {
        const toInsert = textToInsert + ' ';
        const inserted = insertText(toInsert);
        if (inserted) {
          // Update tail with last N chars
          const combined = tail + toInsert;
          lastInsertedTailRef.current = combined.slice(-TAIL_DEDUP_CHARS);
        } else {
          safeLog('[GlobalDictation] Failed to insert text - no active field');
        }
      }
    } catch (err) {
      safeErrorLog('[GlobalDictation] Transcription error:', err);
      const errorMessage = err instanceof Error ? err.message : 'Transcription failed';
      setError(errorMessage);
      onError?.(errorMessage);
    } finally {
      isProcessingRef.current = false;
      
      // Immediately process next in queue (drain completely)
      if (sendQueueRef.current.length > 0) {
        // Use setImmediate-like pattern to allow state updates
        setTimeout(() => processQueue(), 0);
      } else if (isActiveRef.current && !isStoppingRef.current) {
        setStatus('listening');
      }
    }
  }, [getActiveField, insertText, onError, onNoFieldFocused]);

  // Schedule next batch check
  const scheduleBatchCheck = useCallback(() => {
    if (batchTimerRef.current) return;
    
    batchTimerRef.current = setTimeout(() => {
      batchTimerRef.current = null;
      if (isActiveRef.current && !isProcessingRef.current) {
        if (enqueueBatch()) {
          processQueue();
        }
      }
    }, TARGET_DURATION_MS);
  }, [enqueueBatch, processQueue]);

  // Start recording with AudioWorklet
  const startRecording = useCallback(async () => {
    if (status !== 'idle') return;

    try {
      // Session management
      sessionIdRef.current++;
      activeFieldIdAtStartRef.current = activeFieldId;
      isStoppingRef.current = false;
      
      pcmBufferRef.current = [];
      lastInsertedTailRef.current = '';
      recordingStartTimeRef.current = Date.now();
      lastBatchTimeRef.current = 0;
      setError(null);
      isActiveRef.current = true;

      if (DEBUG_AUDIO) {
        console.log('[GlobalDictation] startRecording', {
          sessionId: sessionIdRef.current,
          activeFieldId: activeFieldIdAtStartRef.current,
        });
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

      // Load AudioWorklet from inline code
      const workletBlob = new Blob([workletCode], { type: 'application/javascript' });
      const workletUrl = URL.createObjectURL(workletBlob);
      
      try {
        await audioContext.audioWorklet.addModule(workletUrl);
      } finally {
        URL.revokeObjectURL(workletUrl);
      }

      // Create worklet node
      const workletNode = new AudioWorkletNode(audioContext, 'pcm-processor');
      workletNodeRef.current = workletNode;

      // Handle PCM data from worklet
      workletNode.port.onmessage = (event) => {
        if (!isActiveRef.current) return;
        
        const { pcmData } = event.data;
        if (pcmData) {
          pcmBufferRef.current.push(new Float32Array(pcmData));
          
          // Check if we should enqueue a batch
          const totalSamples = pcmBufferRef.current.reduce((sum, arr) => sum + arr.length, 0);
          const expectedSamplesFor16k = (totalSamples / sourceSampleRateRef.current) * TARGET_SAMPLE_RATE;
          const elapsedMs = Date.now() - (lastBatchTimeRef.current || recordingStartTimeRef.current);
          
          if (expectedSamplesFor16k >= MIN_SAMPLES || elapsedMs >= TARGET_DURATION_MS) {
            if (enqueueBatch()) {
              processQueue();
            }
          } else if (!batchTimerRef.current) {
            scheduleBatchCheck();
          }
        }
      };

      // Connect audio graph
      const sourceNode = audioContext.createMediaStreamSource(stream);
      sourceNodeRef.current = sourceNode;
      sourceNode.connect(workletNode);
      // Note: Don't connect worklet to destination (we don't want to hear ourselves)

      setStatus('listening');
      setIsDictating(true);
      
      if (DEBUG_AUDIO) {
        console.log('[GlobalDictation] Started AudioWorklet capture', {
          sampleRate: audioContext.sampleRate,
          state: audioContext.state,
        });
      }
    } catch (err) {
      safeErrorLog('[GlobalDictation] Microphone access error:', err);
      const errorMessage = err instanceof Error ? err.message : 'Failed to access microphone';
      setError(errorMessage);
      onError?.(errorMessage);
      cleanup();
    }
  }, [status, cleanup, setIsDictating, onError, enqueueBatch, processQueue, scheduleBatchCheck, activeFieldId]);

  // Stop recording with proper drain of send queue
  const stopRecording = useCallback(async () => {
    if (!isActiveRef.current && status === 'idle') return;
    
    // Mark that we're stopping - prevents new audio collection
    isStoppingRef.current = true;
    isActiveRef.current = false;
    
    if (batchTimerRef.current) {
      clearTimeout(batchTimerRef.current);
      batchTimerRef.current = null;
    }

    setStatus('transcribing');

    // Stop the worklet/stream capture so no new audio comes in
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

    if (DEBUG_AUDIO) {
      console.log('[GlobalDictation] stopRecording: starting drain', {
        sessionId: sessionIdRef.current,
        pendingChunksCount: pcmBufferRef.current.length,
        sendQueueLen: sendQueueRef.current.length,
        isProcessing: isProcessingRef.current,
      });
    }

    // Force enqueue any remaining pending chunks
    enqueueBatch({ force: true });

    // DRAIN LOOP: keep draining until queue is empty AND no in-flight request AND no pending chunks
    let drainAttempts = 0;
    const maxDrainAttempts = 40; // Safety limit (40 * 50ms = 2s max)
    
    while (drainAttempts < maxDrainAttempts) {
      const hasWork = isProcessingRef.current || 
                      sendQueueRef.current.length > 0 || 
                      pcmBufferRef.current.length > 0;
      
      if (!hasWork) {
        break; // All drained!
      }
      
      if (DEBUG_AUDIO && drainAttempts % 4 === 0) {
        console.log('[GlobalDictation] drain check', {
          attempt: drainAttempts + 1,
          pendingChunksCount: pcmBufferRef.current.length,
          sendQueueLen: sendQueueRef.current.length,
          isProcessing: isProcessingRef.current,
        });
      }
      
      // If we have pending chunks, enqueue them
      if (pcmBufferRef.current.length > 0) {
        enqueueBatch({ force: true });
      }
      
      // If not processing and queue has items, process next
      if (!isProcessingRef.current && sendQueueRef.current.length > 0) {
        await processQueue();
      } else {
        // Wait for in-flight request to complete
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      
      drainAttempts++;
    }

    // Final safety wait for any last in-flight request
    while (isProcessingRef.current) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    if (DEBUG_AUDIO) {
      console.log('[GlobalDictation] drain complete', {
        drainAttempts,
        pendingChunksCount: pcmBufferRef.current.length,
        sendQueueLen: sendQueueRef.current.length,
      });
    }

    // Now safe to fully cleanup
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    
    pcmBufferRef.current = [];
    sendQueueRef.current = [];
    lastInsertedTailRef.current = '';
    recordingStartTimeRef.current = 0;
    lastBatchTimeRef.current = 0;
    isProcessingRef.current = false;
    isStoppingRef.current = false;
    setIsDictating(false);
    
    setStatus('idle');
    safeLog('[GlobalDictation] Recording stopped, drain complete');
  }, [status, enqueueBatch, processQueue, setIsDictating]);

  // Toggle function
  const toggle = useCallback(async () => {
    if (isActiveRef.current || status === 'listening' || status === 'transcribing') {
      await stopRecording();
      return;
    }

    if (status === 'idle') {
      await startRecording();
    }
  }, [status, startRecording, stopRecording]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isActiveRef.current = false;
      if (batchTimerRef.current) {
        clearTimeout(batchTimerRef.current);
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
    isListening: status === 'listening',
    isTranscribing: status === 'transcribing',
    toggle,
    startRecording,
    stopRecording,
    activeFieldId,
  };
}
