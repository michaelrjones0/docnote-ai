/**
 * EncounterTimings - PHI-safe performance metrics display
 * 
 * Shows timing metrics for the transcription and note generation pipeline:
 * - stopToFinalTranscriptMs: Time from Stop to final transcript
 * - openaiGenerateNoteMs: Time for OpenAI note generation
 * - totalStopToNoteMs: Total time from Stop to note displayed
 * - engine: Current transcription engine
 */

import React from 'react';
import { Clock } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface EncounterTimingsData {
  stopToFinalTranscriptMs: number | null;
  openaiGenerateNoteMs: number | null;
  totalStopToNoteMs: number | null;
  engine: 'Deepgram' | 'AWS Batch' | 'AWS Live' | null;
  connectionTimeMs: number | null;
  audioBytesSent: number;
}

interface EncounterTimingsProps {
  timings: EncounterTimingsData;
  className?: string;
  collapsed?: boolean;
}

function formatMs(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function EncounterTimings({ timings, className, collapsed = false }: EncounterTimingsProps) {
  const hasData = timings.stopToFinalTranscriptMs !== null || 
                  timings.openaiGenerateNoteMs !== null || 
                  timings.totalStopToNoteMs !== null;

  if (collapsed && !hasData) {
    return null;
  }

  return (
    <div className={cn(
      "bg-muted/50 rounded-md border border-border/50 px-3 py-2",
      className
    )}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Clock className="h-3 w-3" />
        <span className="font-medium">Performance</span>
        {timings.engine && (
          <span className="ml-auto px-1.5 py-0.5 bg-primary/10 text-primary rounded text-[10px] font-medium">
            {timings.engine}
          </span>
        )}
      </div>
      
      <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Connection:</span>
          <span className="font-mono">{formatMs(timings.connectionTimeMs)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Audio sent:</span>
          <span className="font-mono">{formatBytes(timings.audioBytesSent)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Stop → Transcript:</span>
          <span className="font-mono">{formatMs(timings.stopToFinalTranscriptMs)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Note generation:</span>
          <span className="font-mono">{formatMs(timings.openaiGenerateNoteMs)}</span>
        </div>
        <div className="col-span-2 flex justify-between pt-1 border-t border-border/30">
          <span className="text-muted-foreground font-medium">Total (Stop → Note):</span>
          <span className={cn(
            "font-mono font-medium",
            timings.totalStopToNoteMs !== null && timings.totalStopToNoteMs < 10000 
              ? "text-green-600" 
              : timings.totalStopToNoteMs !== null && timings.totalStopToNoteMs < 20000
                ? "text-yellow-600"
                : "text-foreground"
          )}>
            {formatMs(timings.totalStopToNoteMs)}
          </span>
        </div>
      </div>
    </div>
  );
}
