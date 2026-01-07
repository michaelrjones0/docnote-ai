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
const TARGET_DURATION_MS = 800;       // Target audio duration per batch
const MIN_SAMPLES = TARGET_SAMPLE_RATE * 0.5; // Minimum samples (~500ms)
const DEDUP_TOLERANCE_MS = 80;        // Tolerance for segment deduplication

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
  
  // Processing state
  const isProcessingRef = useRef(false);
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCommittedEndMsRef = useRef<number>(0);
  const recordingStartTimeRef = useRef<number>(0);
  const lastBatchTimeRef = useRef<number>(0);
  const isActiveRef = useRef(false); // Track if dictation is active

  // Cleanup function
  const cleanup = useCallback(() => {
    isActiveRef.current = false;
    
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
    lastCommittedEndMsRef.current = 0;
    recordingStartTimeRef.current = 0;
    lastBatchTimeRef.current = 0;
    isProcessingRef.current = false;
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

  // Process current batch of PCM samples
  const processBatch = useCallback(async () => {
    if (isProcessingRef.current) return;
    if (pcmBufferRef.current.length === 0) return;
    
    const activeField = getActiveField();
    if (!activeField) {
      pcmBufferRef.current = [];
      safeLog('[GlobalDictation] No active field, clearing queue');
      onNoFieldFocused?.();
      return;
    }

    // Combine all buffered Float32 arrays
    const totalSamples = pcmBufferRef.current.reduce((sum, arr) => sum + arr.length, 0);
    const sourceSampleRate = sourceSampleRateRef.current;
    const expectedSamplesFor16k = (totalSamples / sourceSampleRate) * TARGET_SAMPLE_RATE;
    
    // Check if we have enough audio
    const now = Date.now();
    const elapsedMs = lastBatchTimeRef.current > 0 
      ? now - lastBatchTimeRef.current 
      : now - recordingStartTimeRef.current;
    
    if (expectedSamplesFor16k < MIN_SAMPLES && elapsedMs < TARGET_DURATION_MS) {
      scheduleBatchCheck();
      return;
    }

    // CONSUME buffer - never resend
    const bufferedChunks = pcmBufferRef.current;
    pcmBufferRef.current = [];
    lastBatchTimeRef.current = now;
    isProcessingRef.current = true;
    setStatus('transcribing');

    try {
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
          console.log('[GlobalDictation] near-silence, skipping', { peak: peak.toFixed(6), samples: totalSamples });
        }
        isProcessingRef.current = false;
        if (isActiveRef.current) {
          setStatus('listening');
          if (pcmBufferRef.current.length > 0) scheduleBatchCheck();
        }
        return;
      }

      // Resample to 16kHz mono
      const resampled = resampleToMono16k(combinedSamples, sourceSampleRate);
      
      // Convert to PCM16
      const pcm16 = floatToPCM16(resampled);
      
      // Create WAV file
      const wavBytes = createWavFile(pcm16);
      const wavBase64 = uint8ArrayToBase64(wavBytes);
      
      const durationMs = (resampled.length / TARGET_SAMPLE_RATE) * 1000;
      
      if (DEBUG_AUDIO) {
        console.log('[GlobalDictation] batchSend', {
          sourceSamples: totalSamples,
          sourceSampleRate,
          resampledSamples: resampled.length,
          wavBytes: wavBytes.length,
          durationMs: durationMs.toFixed(0),
          peak: peak.toFixed(4),
          lastCommittedEndMs: lastCommittedEndMsRef.current,
        });
      }

      const startTime = Date.now();

      const { data, error: fnError } = await supabase.functions.invoke('transcribe-audio-live', {
        body: {
          audio: wavBase64,
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

      // Dedupe insertion using segment timestamps
      const segments = Array.isArray(data?.segments) ? data.segments : [];
      const lastEnd = lastCommittedEndMsRef.current;

      const newSegments = segments
        .filter((s: { endMs?: number }) => typeof s?.endMs === 'number' && s.endMs > lastEnd + DEDUP_TOLERANCE_MS)
        .sort((a: { startMs?: number }, b: { startMs?: number }) => (a.startMs ?? 0) - (b.startMs ?? 0));

      const deltaText = newSegments.map((s: { content?: string }) => s.content || '').join(' ').trim();
      const newMaxEndMs = newSegments.length > 0 
        ? Math.max(lastEnd, ...newSegments.map((s: { endMs?: number }) => s.endMs || 0))
        : lastEnd;

      if (DEBUG_AUDIO) {
        console.log('[GlobalDictation] batchRespMeta', {
          segmentsLen: segments.length,
          newSegmentsLen: newSegments.length,
          lastCommittedEndMs: newMaxEndMs,
        });
      }

      if (deltaText) {
        const inserted = insertText(deltaText + ' ');
        if (inserted) {
          lastCommittedEndMsRef.current = newMaxEndMs;
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
      if (isActiveRef.current) {
        setStatus('listening');
        if (pcmBufferRef.current.length > 0) {
          scheduleBatchCheck();
        }
      }
    }
  }, [getActiveField, insertText, onError, onNoFieldFocused, resampleToMono16k, floatToPCM16, createWavFile, uint8ArrayToBase64]);

  // Schedule next batch check
  const scheduleBatchCheck = useCallback(() => {
    if (batchTimerRef.current) return;
    
    batchTimerRef.current = setTimeout(() => {
      batchTimerRef.current = null;
      if (pcmBufferRef.current.length > 0 && !isProcessingRef.current && isActiveRef.current) {
        processBatch();
      }
    }, TARGET_DURATION_MS);
  }, [processBatch]);

  // Start recording with AudioWorklet
  const startRecording = useCallback(async () => {
    if (status !== 'idle') return;

    try {
      pcmBufferRef.current = [];
      lastCommittedEndMsRef.current = 0;
      recordingStartTimeRef.current = Date.now();
      lastBatchTimeRef.current = 0;
      setError(null);
      isActiveRef.current = true;

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
          
          // Check if we should send a batch
          const totalSamples = pcmBufferRef.current.reduce((sum, arr) => sum + arr.length, 0);
          const expectedSamplesFor16k = (totalSamples / sourceSampleRateRef.current) * TARGET_SAMPLE_RATE;
          const elapsedMs = Date.now() - (lastBatchTimeRef.current || recordingStartTimeRef.current);
          
          if (expectedSamplesFor16k >= MIN_SAMPLES || elapsedMs >= TARGET_DURATION_MS) {
            processBatch();
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
  }, [status, cleanup, setIsDictating, onError, processBatch, scheduleBatchCheck]);

  // Stop recording
  const stopRecording = useCallback(async () => {
    if (!isActiveRef.current && status === 'idle') return;
    
    isActiveRef.current = false;
    
    if (batchTimerRef.current) {
      clearTimeout(batchTimerRef.current);
      batchTimerRef.current = null;
    }

    setStatus('transcribing');

    // Process any remaining buffered audio
    if (pcmBufferRef.current.length > 0 && !isProcessingRef.current) {
      await processBatch();
    }

    // Wait for in-flight request to complete
    while (isProcessingRef.current) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    cleanup();
    setStatus('idle');
    safeLog('[GlobalDictation] Recording stopped');
  }, [status, cleanup, processBatch]);

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
