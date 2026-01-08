/**
 * GlobalDictationButton - Main mic toggle for global dictation.
 * 
 * Uses streaming transcription for iPhone-like instant dictation.
 * Falls back to batch mode if streaming is disabled or fails.
 * 
 * UI shows small status indicator for streaming health without blocking.
 */

import { Mic, MicOff, Loader2, WifiOff, Wifi } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useStreamingDictation } from '@/hooks/useStreamingDictation';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

interface GlobalDictationButtonProps {
  className?: string;
  onBatchFallback?: () => void; // Called when streaming is disabled, allows parent to use batch
}

export function GlobalDictationButton({ className, onBatchFallback }: GlobalDictationButtonProps) {
  const { toast } = useToast();

  const { 
    status, 
    toggle, 
    activeFieldId,
    partialText,
    streamHealth,
    isDisabled,
    STREAMING_ENABLED,
  } = useStreamingDictation({
    onError: (error) => {
      toast({
        title: 'Dictation Error',
        description: error,
        variant: 'destructive',
      });
    },
    onNoFieldFocused: () => {
      toast({
        title: 'No field selected',
        description: 'Click into a field to dictate.',
        variant: 'default',
      });
    },
    onStreamingDisabled: () => {
      // Streaming is disabled or failed, fallback to batch
      toast({
        title: 'Streaming unavailable',
        description: 'Using batch transcription mode.',
        variant: 'default',
      });
      onBatchFallback?.();
    },
  });

  const isListening = status === 'listening';
  const isConnecting = status === 'connecting';
  const isStopping = status === 'stopping';
  const isIdle = status === 'idle';

  // If streaming is disabled, show disabled state
  if (isDisabled) {
    return (
      <div className={cn('flex items-center gap-2', className)}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onBatchFallback}
          onMouseDown={(e) => e.preventDefault()}
          onPointerDown={(e) => e.preventDefault()}
          className="opacity-70"
        >
          <Mic className="h-4 w-4 mr-2" />
          Dictate (Batch)
        </Button>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <WifiOff className="h-3 w-3" />
          Streaming off
        </span>
      </div>
    );
  }

  const getButtonContent = () => {
    if (isConnecting) {
      return (
        <>
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          Connecting…
        </>
      );
    }
    if (isStopping) {
      return (
        <>
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          Stopping…
        </>
      );
    }
    if (isIdle) {
      return (
        <>
          <Mic className="h-4 w-4 mr-2" />
          Dictate
        </>
      );
    }
    // Listening
    return (
      <>
        <MicOff className="h-4 w-4 mr-2" />
        Stop
      </>
    );
  };

  // Small status indicator - never blocks controls
  const getStreamHealthIndicator = () => {
    if (streamHealth === 'online') {
      return (
        <span className="flex items-center gap-1 text-xs text-green-600">
          <Wifi className="h-3 w-3" />
          Live
        </span>
      );
    }
    if (streamHealth === 'connecting') {
      return (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Connecting
        </span>
      );
    }
    // offline - only show when idle (not during active session)
    if (isIdle) {
      return (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <WifiOff className="h-3 w-3" />
          Ready
        </span>
      );
    }
    return null;
  };

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Button
        type="button"
        variant={isListening ? 'destructive' : 'default'}
        size="sm"
        onClick={toggle}
        // Stop is ALWAYS enabled - never disable during connecting/stopping
        disabled={false}
        onMouseDown={(e) => e.preventDefault()}
        onPointerDown={(e) => e.preventDefault()}
        className={cn(
          'transition-all',
          isListening && 'animate-pulse'
        )}
      >
        {getButtonContent()}
      </Button>
      
      {/* Small streaming health indicator - never blocks UI */}
      {getStreamHealthIndicator()}
      
      {/* Listening indicator with field info */}
      {isListening && (
        <span className="flex items-center gap-1 text-xs">
          <span className="w-2 h-2 rounded-full bg-destructive animate-pulse" />
          {activeFieldId ? 'Listening' : 'No field'}
        </span>
      )}
      
      {/* Show partial text preview while streaming */}
      {isListening && partialText && (
        <span className="text-xs text-muted-foreground italic max-w-[200px] truncate">
          {partialText}
        </span>
      )}
    </div>
  );
}
