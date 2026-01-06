/**
 * GlobalDictationButton - Main mic toggle for global dictation.
 * 
 * Shows: Idle / Listening / Transcribing states
 * Placed in main header/toolbar area.
 */

import { Mic, MicOff, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useGlobalDictation } from '@/hooks/useGlobalDictation';
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
    activeFieldId 
  } = useGlobalDictation({
    chunkIntervalMs: 3000,
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
  const isTranscribing = status === 'transcribing';
  const isIdle = status === 'idle';

  const getButtonContent = () => {
    if (isListening) {
      return (
        <>
          <MicOff className="h-4 w-4 mr-2" />
          Stop Dictation
        </>
      );
    }
    if (isTranscribing) {
      return (
        <>
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          Transcribing…
        </>
      );
    }
    return (
      <>
        <Mic className="h-4 w-4 mr-2" />
        Dictate
      </>
    );
  };

  const getStatusIndicator = () => {
    if (!isListening && !isTranscribing) return null;
    
    return (
      <span className="flex items-center gap-1 text-xs ml-2">
        {isListening && (
          <>
            <span className="w-2 h-2 rounded-full bg-destructive animate-pulse" />
            {activeFieldId ? 'Listening' : 'No field'}
          </>
        )}
        {isTranscribing && 'Processing…'}
      </span>
    );
  };

  return (
    <div className={cn('flex items-center', className)}>
      <Button
        type="button"
        variant={isListening ? 'destructive' : 'default'}
        size="sm"
        onClick={toggle}
        disabled={isTranscribing}
        className={cn(
          'transition-all',
          isListening && 'animate-pulse'
        )}
      >
        {getButtonContent()}
      </Button>
      {getStatusIndicator()}
    </div>
  );
}
