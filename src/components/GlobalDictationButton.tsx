/**
 * GlobalDictationButton - Main mic toggle for global dictation.
 * 
 * Uses streaming transcription for iPhone-like instant dictation.
 * Falls back to batch mode if streaming fails.
 */

import { Mic, MicOff, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useStreamingDictation } from '@/hooks/useStreamingDictation';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

interface GlobalDictationButtonProps {
  className?: string;
}

export function GlobalDictationButton({ className }: GlobalDictationButtonProps) {
  const { toast } = useToast();

  const { 
    status, 
    toggle, 
    activeFieldId,
    partialText,
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
  });

  const isListening = status === 'listening';
  const isConnecting = status === 'connecting';
  const isStopping = status === 'stopping';
  const isIdle = status === 'idle';

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

  const getStatusIndicator = () => {
    if (isIdle || isConnecting || isStopping) return null;
    
    return (
      <span className="flex items-center gap-1 text-xs ml-2">
        {isListening && (
          <>
            <span className="w-2 h-2 rounded-full bg-destructive animate-pulse" />
            {activeFieldId ? 'Listening' : 'No field'}
          </>
        )}
      </span>
    );
  };

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Button
        type="button"
        variant={isListening ? 'destructive' : 'default'}
        size="sm"
        onClick={toggle}
        disabled={isConnecting || isStopping}
        onMouseDown={(e) => e.preventDefault()}
        onPointerDown={(e) => e.preventDefault()}
        className={cn(
          'transition-all',
          isListening && 'animate-pulse'
        )}
      >
        {getButtonContent()}
      </Button>
      {getStatusIndicator()}
      {/* Show partial text preview while streaming */}
      {isListening && partialText && (
        <span className="text-xs text-muted-foreground italic max-w-[200px] truncate">
          {partialText}
        </span>
      )}
    </div>
  );
}
