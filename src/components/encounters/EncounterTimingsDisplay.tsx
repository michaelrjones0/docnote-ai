/**
 * EncounterTimingsDisplay - PHI-safe timing display for encounter pipeline.
 * Shows timing instrumentation for debugging and optimization.
 */

import { Clock, Zap, Database, FileText, CheckCircle2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { EncounterTimings } from '@/hooks/useEncounterTimings';

interface EncounterTimingsDisplayProps {
  timings: EncounterTimings;
  formatTiming: (ms: number | null) => string;
  batchStatus?: 'idle' | 'uploading' | 'processing' | 'completed' | 'failed' | 'timeout';
  className?: string;
}

export function EncounterTimingsDisplay({ 
  timings, 
  formatTiming, 
  batchStatus = 'idle',
  className 
}: EncounterTimingsDisplayProps) {
  const showRecording = timings.recordingDurationMs !== null;
  const showDraft = timings.stopToDraftMs !== null;
  const showBatch = batchStatus !== 'idle';
  const showGenerate = timings.generateDurationMs !== null;

  // Don't render if no data yet
  if (!showRecording && !showDraft && !showBatch && !showGenerate) {
    return null;
  }

  return (
    <div className={cn(
      'flex flex-wrap items-center gap-2 text-xs text-muted-foreground',
      className
    )}>
      <span className="flex items-center gap-1">
        <Clock className="h-3 w-3" />
        Timings:
      </span>

      {/* Recording duration */}
      {showRecording && (
        <Badge variant="outline" className="text-xs font-normal gap-1">
          <span className="text-muted-foreground">Rec:</span>
          {formatTiming(timings.recordingDurationMs)}
        </Badge>
      )}

      {/* Stop → Draft */}
      {showDraft && (
        <Badge variant="outline" className="text-xs font-normal gap-1">
          <Zap className="h-3 w-3 text-yellow-500" />
          <span className="text-muted-foreground">Draft:</span>
          {formatTiming(timings.stopToDraftMs)}
        </Badge>
      )}

      {/* Batch status */}
      {showBatch && (
        <Badge 
          variant="outline" 
          className={cn(
            'text-xs font-normal gap-1',
            batchStatus === 'completed' && 'border-green-500/50',
            batchStatus === 'processing' && 'border-blue-500/50',
            batchStatus === 'failed' && 'border-destructive/50',
          )}
        >
          <Database className={cn(
            'h-3 w-3',
            batchStatus === 'processing' && 'animate-pulse text-blue-500',
            batchStatus === 'completed' && 'text-green-500',
            batchStatus === 'failed' && 'text-destructive',
          )} />
          <span className="text-muted-foreground">Batch:</span>
          {batchStatus === 'processing' && 'Processing...'}
          {batchStatus === 'uploading' && 'Uploading...'}
          {batchStatus === 'completed' && formatTiming(timings.batchProcessingMs)}
          {batchStatus === 'failed' && 'Failed'}
          {batchStatus === 'timeout' && 'Timeout'}
        </Badge>
      )}

      {/* Generate → Note */}
      {showGenerate && (
        <Badge 
          variant="outline" 
          className={cn(
            'text-xs font-normal gap-1',
            'border-primary/50'
          )}
        >
          <FileText className="h-3 w-3 text-primary" />
          <span className="text-muted-foreground">SOAP:</span>
          {formatTiming(timings.generateDurationMs)}
        </Badge>
      )}

      {/* Transcript source indicator */}
      {timings.transcriptSource && (
        <Badge 
          variant={timings.transcriptSource === 'batch' ? 'default' : 'secondary'}
          className="text-xs font-normal gap-1"
        >
          <CheckCircle2 className="h-3 w-3" />
          {timings.transcriptSource === 'batch' ? 'High-Fidelity' : 'Draft'}
        </Badge>
      )}
    </div>
  );
}
