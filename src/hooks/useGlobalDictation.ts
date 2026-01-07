/**
 * useGlobalDictation - Global continuous dictation hook.
 * 
 * Architecture:
 * - ONE MediaRecorder + stream (single mic session)
 * - Continuously records and emits audio chunks on interval
 * - Transcribes each chunk and inserts into currently focused field
 * - Future-proof: logic isolated here for easy swap to streaming STT
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
// TEMPORARY DEBUG FLAG - set to true to enable PHI-safe audio diagnostics
// ============================================================================
const DEBUG_AUDIO = true;

export type GlobalDictationStatus = 'idle' | 'listening' | 'transcribing';

// Instant dictation tuning constants
const MIN_BYTES = 8_000;        // Minimum buffer size to send (8 KB)
const TARGET_MS = 800;          // Target audio duration per batch (ms)
const TIMESLICE_MS = 250;       // MediaRecorder timeslice for frequent chunks
const DEDUP_TOLERANCE_MS = 80;  // Tolerance for segment deduplication

interface UseGlobalDictationOptions {
  onError?: (error: string) => void;
  onNoFieldFocused?: () => void;
}

export function useGlobalDictation({
  onError,
  onNoFieldFocused,
}: UseGlobalDictationOptions = {}) {
  const { insertText, getActiveField, setIsDictating, activeFieldId } = useDictationContext();
  
  const [status, setStatus] = useState<GlobalDictationStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const pendingBlobsRef = useRef<Blob[]>([]);
  const isProcessingRef = useRef(false);
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // WebM init segment (first chunk with headers) - needed for subsequent chunk decoding
  const webmInitBlobRef = useRef<Blob | null>(null);
  // Track last committed segment endMs to dedupe overlapping transcripts
  const lastCommittedEndMsRef = useRef<number>(0);
  // Track recording start time for estimating audio duration
  const recordingStartTimeRef = useRef<number>(0);
  const lastBatchTimeRef = useRef<number>(0);

  // Cleanup function
  const cleanup = useCallback(() => {
    if (batchTimerRef.current) {
      clearTimeout(batchTimerRef.current);
      batchTimerRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    mediaRecorderRef.current = null;
    pendingBlobsRef.current = [];
    webmInitBlobRef.current = null;
    lastCommittedEndMsRef.current = 0;
    recordingStartTimeRef.current = 0;
    lastBatchTimeRef.current = 0;
    isProcessingRef.current = false;
    setIsDictating(false);
  }, [setIsDictating]);

  // Schedule next batch check
  const scheduleBatchCheck = useCallback(() => {
    if (batchTimerRef.current) return; // Already scheduled
    
    batchTimerRef.current = setTimeout(() => {
      batchTimerRef.current = null;
      // Trigger processing if we have enough audio
      if (pendingBlobsRef.current.length > 0 && !isProcessingRef.current) {
        processBatch();
      }
    }, TARGET_MS);
  }, []);

  // Process current batch of audio chunks
  const processBatch = useCallback(async () => {
    // Single in-flight request enforcement
    if (isProcessingRef.current) {
      // Just buffer, don't start another request
      return;
    }
    
    if (pendingBlobsRef.current.length === 0) return;
    
    const activeField = getActiveField();
    if (!activeField) {
      // Clear queue to prevent dumping into next field later
      pendingBlobsRef.current = [];
      safeLog('[GlobalDictation] No active field, clearing queue');
      onNoFieldFocused?.();
      return;
    }

    // Build a blob with init segment prepended (needed for webm decoding)
    const init = webmInitBlobRef.current;
    const chunksToProcess = [...pendingBlobsRef.current];
    const parts = init ? [init, ...chunksToProcess] : [...chunksToProcess];
    const blobMimeType = init?.type || chunksToProcess[0]?.type || 'audio/webm;codecs=opus';
    const blob = new Blob(parts, { type: blobMimeType });
    
    // Calculate approximate audio duration based on time elapsed
    const now = Date.now();
    const approxDurationMs = lastBatchTimeRef.current > 0 
      ? now - lastBatchTimeRef.current 
      : now - recordingStartTimeRef.current;
    
    // PHI-safe batch send log
    console.log('[GlobalDictation] batchSend', {
      chunkCount: chunksToProcess.length,
      batchBytes: blob.size,
      approxDurationMs,
      lastCommittedEndMs: lastCommittedEndMsRef.current,
    });
    
    // If combined blob is too small and we haven't waited long enough, defer
    if (blob.size < MIN_BYTES && approxDurationMs < TARGET_MS) {
      scheduleBatchCheck();
      return;
    }

    // CONSUME blobs from queue - never resend overlapping audio
    pendingBlobsRef.current = [];
    lastBatchTimeRef.current = now;
    isProcessingRef.current = true;
    setStatus('transcribing');

    try {
      // ========================================================================
      // STEP 1: PHI-safe audio signal check using WebAudio (decode webm)
      // ========================================================================
      const { decodeOk, rms, peak, sampleRate: srcSampleRate, channels: srcChannels, duration: srcDuration } = await getAudioLevels(blob);
      
      if (DEBUG_AUDIO) {
        console.log('[DictationAudioDebug] step=getAudioLevels', {
          blobSize: blob.size,
          blobType: blob.type,
          decodeOk,
          rms: rms.toFixed(6),
          peak: peak.toFixed(6),
          srcSampleRate,
          srcChannels,
          srcDuration: srcDuration?.toFixed(3),
        });
      }

      // Skip transcription if near-silence
      if (decodeOk && peak < 0.01) {
        console.log('[GlobalDictation] near-silence, skipping transcription', { 
          audioBytes: blob.size, 
          mimeType: blob.type, 
          rms, 
          peak 
        });
        onError?.('No microphone input detected (audio is near-silence). Check mic selection/permissions.');
        isProcessingRef.current = false;
        if (mediaRecorderRef.current?.state === 'recording') {
          setStatus('listening');
        }
        if (pendingBlobsRef.current.length > 0) {
          scheduleBatchCheck();
        }
        return;
      }

      // ========================================================================
      // STEP 2: Decode webm -> resample to 16kHz mono -> encode WAV PCM16
      // ========================================================================
      let wavBase64: string;
      let wavBytes: Uint8Array;
      
      try {
        const result = await convertToWav16kMono(blob);
        wavBase64 = result.base64;
        wavBytes = result.wavBytes;
        
        if (DEBUG_AUDIO) {
          // Validate WAV header
          const wavValidation = validateWavHeader(wavBytes);
          const first16Hex = Array.from(wavBytes.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ');
          
          console.log('[DictationAudioDebug] step=convertToWav16kMono', {
            wavBytesLength: wavBytes.length,
            base64Length: wavBase64.length,
            first16Hex,
            ...wavValidation
          });
        }
      } catch (convErr) {
        console.error('[DictationAudioDebug] step=convertToWav16kMono errorName=' + (convErr instanceof Error ? convErr.name : 'Unknown'), 
          'message=' + (convErr instanceof Error ? convErr.message : String(convErr)));
        isProcessingRef.current = false;
        if (mediaRecorderRef.current?.state === 'recording') {
          setStatus('listening');
        }
        if (pendingBlobsRef.current.length > 0) {
          scheduleBatchCheck();
        }
        return;
      }

      const startTime = Date.now();

      if (DEBUG_AUDIO) {
        console.log('[DictationAudioDebug] step=sendToEdge', {
          payloadMimeType: 'audio/wav',
          base64Length: wavBase64.length,
        });
      }

      // PHI-SAFE: Only request full transcript content in debug mode
      // Production requests get empty text but full metadata (textLen, segmentsLen)
      const { data, error: fnError } = await supabase.functions.invoke('transcribe-audio-live', {
        body: {
          audio: wavBase64,
          chunkIndex: 0,
          mimeType: 'audio/wav', // Now sending actual WAV
          sampleRate: 16000,
          encoding: 'pcm16',
          debug: DEBUG_AUDIO, // Only true in dev/demo mode
        },
      });

      // PHI-safe debug log after response (only lengths, never content)
      console.log('[GlobalDictation] response meta', { 
        textLen: data?.meta?.textLen ?? (data?.text?.trim()?.length ?? 0), 
        segmentsLen: data?.meta?.segmentsLen ?? (data?.segments?.length ?? 0),
        meta: data?.meta,
      });

      safeLog('[GlobalDictation] Transcription complete', { 
        durationMs: Date.now() - startTime,
        hasText: !!data?.text 
      });

      if (fnError) {
        throw fnError;
      }

      // Dedupe insertion using segment timestamps to avoid repeating overlapping content
      const segments = Array.isArray(data?.segments) ? data.segments : [];
      const lastEnd = lastCommittedEndMsRef.current;

      // Filter to only new segments beyond what we've already committed (with tolerance)
      const newSegments = segments
        .filter((s: { endMs?: number }) => typeof s?.endMs === 'number' && s.endMs > lastEnd + DEDUP_TOLERANCE_MS)
        .sort((a: { startMs?: number }, b: { startMs?: number }) => (a.startMs ?? 0) - (b.startMs ?? 0));

      const deltaText = newSegments.map((s: { content?: string }) => s.content || '').join(' ').trim();
      const newMaxEndMs = newSegments.length > 0 
        ? Math.max(lastEnd, ...newSegments.map((s: { endMs?: number }) => s.endMs || 0))
        : lastEnd;

      // PHI-safe response metadata log
      console.log('[GlobalDictation] batchRespMeta', {
        segmentsLen: segments.length,
        newSegmentsLen: newSegments.length,
        lastCommittedEndMs: newMaxEndMs,
      });

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
      // Only set back to listening if still recording
      if (mediaRecorderRef.current?.state === 'recording') {
        setStatus('listening');
        // If more chunks accumulated while processing, schedule next batch
        if (pendingBlobsRef.current.length > 0) {
          scheduleBatchCheck();
        }
      }
    }
  }, [getActiveField, insertText, onError, onNoFieldFocused, scheduleBatchCheck]);

  // Start recording
  const startRecording = useCallback(async () => {
    if (status !== 'idle') return;

    try {
      // Reset for new recording session
      pendingBlobsRef.current = [];
      webmInitBlobRef.current = null;
      lastCommittedEndMsRef.current = 0;
      recordingStartTimeRef.current = Date.now();
      lastBatchTimeRef.current = 0;
      setError(null);
      
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      streamRef.current = stream;
      
      const recorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm',
      });

      recorder.ondataavailable = (event) => {
        if (event.data?.size > 0) {
          // Capture first chunk as init segment (contains webm headers)
          if (!webmInitBlobRef.current) {
            webmInitBlobRef.current = event.data;
            if (DEBUG_AUDIO) {
              console.log('[DictationAudioDebug] captured init segment', {
                initSize: event.data.size,
                initType: event.data.type,
              });
            }
          }
          pendingBlobsRef.current.push(event.data);
          
          // Check if we should send a batch (have enough data or time elapsed)
          const batchBytes = pendingBlobsRef.current.reduce((sum, b) => sum + b.size, 0);
          const elapsedMs = Date.now() - (lastBatchTimeRef.current || recordingStartTimeRef.current);
          
          if (batchBytes >= MIN_BYTES || elapsedMs >= TARGET_MS) {
            processBatch();
          } else {
            scheduleBatchCheck();
          }
        }
      };

      recorder.onstop = () => {
        cleanup();
        setStatus('idle');
      };

      mediaRecorderRef.current = recorder;
      // Start WITH timeslice for frequent small chunks (instant feel)
      recorder.start(TIMESLICE_MS);

      setStatus('listening');
      setIsDictating(true);
      safeLog('[GlobalDictation] Recording started with instant dictation mode');
    } catch (err) {
      safeErrorLog('[GlobalDictation] Microphone access error:', err);
      const errorMessage = err instanceof Error 
        ? err.message 
        : 'Failed to access microphone';
      setError(errorMessage);
      onError?.(errorMessage);
      cleanup();
    }
  }, [status, processBatch, scheduleBatchCheck, cleanup, setIsDictating, onError]);

  // Stop recording
  const stopRecording = useCallback(async () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) {
      cleanup();
      setStatus('idle');
      return;
    }

    // Clear the batch timer
    if (batchTimerRef.current) {
      clearTimeout(batchTimerRef.current);
      batchTimerRef.current = null;
    }

    // Request final data before stopping
    if (recorder.state === 'recording') {
      setStatus('transcribing');
      recorder.requestData();
      
      // Give a moment for ondataavailable to fire, then stop
      await new Promise(resolve => setTimeout(resolve, 100));
      recorder.stop();
      
      // Wait for any pending transcription to complete
      while (isProcessingRef.current || pendingBlobsRef.current.length > 0) {
        await new Promise(resolve => setTimeout(resolve, 50));
        if (!isProcessingRef.current && pendingBlobsRef.current.length > 0) {
          await processBatch();
        }
      }
    } else {
      cleanup();
      setStatus('idle');
    }

    safeLog('[GlobalDictation] Recording stopped');
  }, [cleanup, processBatch]);

  // Toggle function - always allow stopping if recording
  const toggle = useCallback(async () => {
    const recorder = mediaRecorderRef.current;
    const isRecording = recorder?.state === 'recording';

    if (isRecording) {
      await stopRecording();
      return;
    }

    // Only start if truly idle
    if (status === 'idle') {
      await startRecording();
    }
  }, [status, startRecording, stopRecording]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (batchTimerRef.current) {
        clearTimeout(batchTimerRef.current);
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
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

// Helper to convert Blob to base64
async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Helper to get audio levels for silence detection (PHI-safe)
// Also returns source audio metadata for debugging
async function getAudioLevels(blob: Blob): Promise<{ 
  decodeOk: boolean; 
  rms: number; 
  peak: number;
  sampleRate?: number;
  channels?: number;
  duration?: number;
}> {
  try {
    const ab = await blob.arrayBuffer();
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const audioBuf = await ctx.decodeAudioData(ab.slice(0));
    const data = audioBuf.getChannelData(0);
    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
      sumSq += data[i] * data[i];
    }
    const rms = Math.sqrt(sumSq / Math.max(1, data.length));
    const sampleRate = audioBuf.sampleRate;
    const channels = audioBuf.numberOfChannels;
    const duration = audioBuf.duration;
    await ctx.close();
    return { decodeOk: true, rms, peak, sampleRate, channels, duration };
  } catch {
    return { decodeOk: false, rms: 0, peak: 0 };
  }
}

// ============================================================================
// Convert webm/opus blob -> 16kHz mono PCM16 WAV
// ============================================================================
async function convertToWav16kMono(blob: Blob): Promise<{ base64: string; wavBytes: Uint8Array }> {
  // Step 1: Decode the blob (webm) into an AudioBuffer
  const arrayBuffer = await blob.arrayBuffer();
  const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  const sourceBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
  
  if (DEBUG_AUDIO) {
    console.log('[DictationAudioDebug] step=decodeAudioData', {
      sourceSampleRate: sourceBuffer.sampleRate,
      sourceChannels: sourceBuffer.numberOfChannels,
      sourceDuration: sourceBuffer.duration.toFixed(3),
      sourceLength: sourceBuffer.length,
    });
  }
  
  // Step 2: Resample to 16kHz mono using OfflineAudioContext
  const targetSampleRate = 16000;
  const targetChannels = 1;
  const targetLength = Math.ceil(sourceBuffer.duration * targetSampleRate);
  
  const offlineCtx = new OfflineAudioContext(targetChannels, targetLength, targetSampleRate);
  const source = offlineCtx.createBufferSource();
  source.buffer = sourceBuffer;
  source.connect(offlineCtx.destination);
  source.start(0);
  
  const resampledBuffer = await offlineCtx.startRendering();
  
  if (DEBUG_AUDIO) {
    console.log('[DictationAudioDebug] step=resample', {
      targetSampleRate: resampledBuffer.sampleRate,
      targetChannels: resampledBuffer.numberOfChannels,
      targetLength: resampledBuffer.length,
      targetDuration: resampledBuffer.duration.toFixed(3),
    });
  }
  
  await audioCtx.close();
  
  // Step 3: Convert float samples to PCM16
  const floatData = resampledBuffer.getChannelData(0);
  const pcm16 = new Int16Array(floatData.length);
  for (let i = 0; i < floatData.length; i++) {
    const s = Math.max(-1, Math.min(1, floatData[i]));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  
  // Step 4: Create WAV header + data
  const wavBytes = createWavFile(pcm16, targetSampleRate, targetChannels);
  
  if (DEBUG_AUDIO) {
    console.log('[DictationAudioDebug] step=encodeWav', {
      pcm16Length: pcm16.length,
      wavBytesLength: wavBytes.length,
    });
  }
  
  // Step 5: Convert to base64
  const base64 = uint8ArrayToBase64(wavBytes);
  
  return { base64, wavBytes };
}

// Create a complete WAV file from PCM16 data
function createWavFile(pcm16: Int16Array, sampleRate: number, channels: number): Uint8Array {
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataBytes = pcm16.length * 2; // 2 bytes per sample
  const headerSize = 44;
  
  const buffer = new ArrayBuffer(headerSize + dataBytes);
  const view = new DataView(buffer);
  
  // RIFF header
  view.setUint8(0, 0x52); // R
  view.setUint8(1, 0x49); // I
  view.setUint8(2, 0x46); // F
  view.setUint8(3, 0x46); // F
  view.setUint32(4, 36 + dataBytes, true); // File size - 8
  view.setUint8(8, 0x57);  // W
  view.setUint8(9, 0x41);  // A
  view.setUint8(10, 0x56); // V
  view.setUint8(11, 0x45); // E
  
  // fmt chunk
  view.setUint8(12, 0x66); // f
  view.setUint8(13, 0x6D); // m
  view.setUint8(14, 0x74); // t
  view.setUint8(15, 0x20); // (space)
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true); // AudioFormat (1 = PCM)
  view.setUint16(22, channels, true); // NumChannels
  view.setUint32(24, sampleRate, true); // SampleRate
  view.setUint32(28, byteRate, true); // ByteRate
  view.setUint16(32, blockAlign, true); // BlockAlign
  view.setUint16(34, bitsPerSample, true); // BitsPerSample
  
  // data chunk
  view.setUint8(36, 0x64); // d
  view.setUint8(37, 0x61); // a
  view.setUint8(38, 0x74); // t
  view.setUint8(39, 0x61); // a
  view.setUint32(40, dataBytes, true); // Subchunk2Size
  
  // Copy PCM data
  const pcmBytes = new Uint8Array(pcm16.buffer);
  new Uint8Array(buffer).set(pcmBytes, headerSize);
  
  return new Uint8Array(buffer);
}

// Convert Uint8Array to base64 (efficient chunked approach)
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000; // 32KB chunks to avoid call stack issues
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

// Validate WAV header and return PHI-safe metadata
function validateWavHeader(wavBytes: Uint8Array): {
  isRiff: boolean;
  isWave: boolean;
  fmtChunkFound: boolean;
  numChannels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataBytes: number;
} {
  const view = new DataView(wavBytes.buffer, wavBytes.byteOffset, wavBytes.byteLength);
  
  const isRiff = wavBytes[0] === 0x52 && wavBytes[1] === 0x49 && wavBytes[2] === 0x46 && wavBytes[3] === 0x46;
  const isWave = wavBytes[8] === 0x57 && wavBytes[9] === 0x41 && wavBytes[10] === 0x56 && wavBytes[11] === 0x45;
  const fmtChunkFound = wavBytes[12] === 0x66 && wavBytes[13] === 0x6D && wavBytes[14] === 0x74 && wavBytes[15] === 0x20;
  
  const numChannels = fmtChunkFound ? view.getUint16(22, true) : 0;
  const sampleRate = fmtChunkFound ? view.getUint32(24, true) : 0;
  const bitsPerSample = fmtChunkFound ? view.getUint16(34, true) : 0;
  const dataBytes = wavBytes.length >= 44 ? view.getUint32(40, true) : 0;
  
  return { isRiff, isWave, fmtChunkFound, numChannels, sampleRate, bitsPerSample, dataBytes };
}
