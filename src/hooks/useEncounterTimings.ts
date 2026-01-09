/**
 * useEncounterTimings - PHI-safe timing instrumentation for encounter pipeline.
 * 
 * Tracks timing for:
 * - stop→draft: Time from recording stop to live transcript ready
 * - stop→batchStart: Time from stop to batch job initiated
 * - batchStart→batchComplete: AWS batch processing time
 * - generate→note: Time to generate SOAP note from transcript
 * 
 * All values are in milliseconds. No PHI is logged.
 */

import { useState, useCallback, useRef } from 'react';
import { safeLog } from '@/lib/debug';

export interface EncounterTimings {
  // Recording phase
  recordingStartedAt: number | null;
  recordingStoppedAt: number | null;
  recordingDurationMs: number | null;
  
  // Draft transcript (live chunks)
  draftReadyAt: number | null;
  stopToDraftMs: number | null;
  
  // Batch refinement
  batchStartedAt: number | null;
  batchCompletedAt: number | null;
  stopToBatchStartMs: number | null;
  batchProcessingMs: number | null;
  
  // Note generation
  generateStartedAt: number | null;
  generateCompletedAt: number | null;
  generateDurationMs: number | null;
  
  // Metadata
  transcriptSource: 'draft' | 'batch' | null;
  lastUpdated: string;
}

const getEmptyTimings = (): EncounterTimings => ({
  recordingStartedAt: null,
  recordingStoppedAt: null,
  recordingDurationMs: null,
  draftReadyAt: null,
  stopToDraftMs: null,
  batchStartedAt: null,
  batchCompletedAt: null,
  stopToBatchStartMs: null,
  batchProcessingMs: null,
  generateStartedAt: null,
  generateCompletedAt: null,
  generateDurationMs: null,
  transcriptSource: null,
  lastUpdated: new Date().toISOString(),
});

export function useEncounterTimings() {
  const [timings, setTimings] = useState<EncounterTimings>(getEmptyTimings);
  const timingsRef = useRef<EncounterTimings>(getEmptyTimings());

  const updateTimings = useCallback((updates: Partial<EncounterTimings>) => {
    setTimings(prev => {
      const newTimings = { 
        ...prev, 
        ...updates, 
        lastUpdated: new Date().toISOString() 
      };
      timingsRef.current = newTimings;
      return newTimings;
    });
  }, []);

  // Mark recording started
  const markRecordingStarted = useCallback(() => {
    const now = Date.now();
    safeLog('[Timings] Recording started');
    updateTimings({
      recordingStartedAt: now,
      recordingStoppedAt: null,
      recordingDurationMs: null,
      draftReadyAt: null,
      stopToDraftMs: null,
      batchStartedAt: null,
      batchCompletedAt: null,
      stopToBatchStartMs: null,
      batchProcessingMs: null,
      generateStartedAt: null,
      generateCompletedAt: null,
      generateDurationMs: null,
      transcriptSource: null,
    });
  }, [updateTimings]);

  // Mark recording stopped (start of stop→draft timer)
  const markRecordingStopped = useCallback(() => {
    const now = Date.now();
    const startedAt = timingsRef.current.recordingStartedAt;
    const durationMs = startedAt ? now - startedAt : null;
    
    safeLog('[Timings] Recording stopped, durationMs:', durationMs);
    updateTimings({
      recordingStoppedAt: now,
      recordingDurationMs: durationMs,
    });
    
    return now;
  }, [updateTimings]);

  // Mark draft transcript ready
  const markDraftReady = useCallback(() => {
    const now = Date.now();
    const stoppedAt = timingsRef.current.recordingStoppedAt;
    const stopToDraftMs = stoppedAt ? now - stoppedAt : null;
    
    safeLog('[Timings] Draft ready, stopToDraftMs:', stopToDraftMs);
    updateTimings({
      draftReadyAt: now,
      stopToDraftMs,
      transcriptSource: 'draft',
    });
  }, [updateTimings]);

  // Mark batch job started
  const markBatchStarted = useCallback(() => {
    const now = Date.now();
    const stoppedAt = timingsRef.current.recordingStoppedAt;
    const stopToBatchStartMs = stoppedAt ? now - stoppedAt : null;
    
    safeLog('[Timings] Batch started, stopToBatchStartMs:', stopToBatchStartMs);
    updateTimings({
      batchStartedAt: now,
      stopToBatchStartMs,
    });
  }, [updateTimings]);

  // Mark batch job completed
  const markBatchCompleted = useCallback(() => {
    const now = Date.now();
    const startedAt = timingsRef.current.batchStartedAt;
    const batchProcessingMs = startedAt ? now - startedAt : null;
    
    safeLog('[Timings] Batch completed, batchProcessingMs:', batchProcessingMs);
    updateTimings({
      batchCompletedAt: now,
      batchProcessingMs,
    });
  }, [updateTimings]);

  // Mark note generation started
  const markGenerateStarted = useCallback((source: 'draft' | 'batch') => {
    const now = Date.now();
    safeLog('[Timings] Generate started, source:', source);
    updateTimings({
      generateStartedAt: now,
      transcriptSource: source,
    });
    return now;
  }, [updateTimings]);

  // Mark note generation completed
  const markGenerateCompleted = useCallback(() => {
    const now = Date.now();
    const startedAt = timingsRef.current.generateStartedAt;
    const generateDurationMs = startedAt ? now - startedAt : null;
    
    safeLog('[Timings] Generate completed, generateDurationMs:', generateDurationMs);
    updateTimings({
      generateCompletedAt: now,
      generateDurationMs,
    });
    
    return generateDurationMs;
  }, [updateTimings]);

  // Reset all timings
  const resetTimings = useCallback(() => {
    safeLog('[Timings] Reset');
    setTimings(getEmptyTimings());
    timingsRef.current = getEmptyTimings();
  }, []);

  // Format timing for display (returns "Xms" or "X.Xs" for larger values)
  const formatTiming = useCallback((ms: number | null): string => {
    if (ms === null) return '—';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }, []);

  // Get display-friendly summary
  const getTimingSummary = useCallback(() => {
    const t = timingsRef.current;
    return {
      recording: formatTiming(t.recordingDurationMs),
      stopToDraft: formatTiming(t.stopToDraftMs),
      stopToBatchStart: formatTiming(t.stopToBatchStartMs),
      batchProcessing: formatTiming(t.batchProcessingMs),
      generateNote: formatTiming(t.generateDurationMs),
      source: t.transcriptSource,
    };
  }, [formatTiming]);

  return {
    timings,
    markRecordingStarted,
    markRecordingStopped,
    markDraftReady,
    markBatchStarted,
    markBatchCompleted,
    markGenerateStarted,
    markGenerateCompleted,
    resetTimings,
    formatTiming,
    getTimingSummary,
  };
}
