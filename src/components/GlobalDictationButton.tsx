/**
 * GlobalDictationButton - Main mic toggle for global dictation.
 * 
 * Uses batch transcription (useGlobalDictation) for reliable dictation.
 * Streaming is disabled by default until WS backend is stable.
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
    activeFieldId,
  } = useGlobalDictation({
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
    if (isTranscribing) {
      return (
        <>
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          Transcribing…
        </>
      );
    }
    if (isListening) {
      return (
        <>
          <MicOff className="h-4 w-4 mr-2" />
          Stop Dictation
        </>
      );
    }
    // Idle
    return (
      <>
        <Mic className="h-4 w-4 mr-2" />
        Dictate
      </>
    );
  };

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Button
        type="button"
        variant={isListening || isTranscribing ? 'destructive' : 'default'}
        size="sm"
        onClick={toggle}
        // Never disable - stop always works
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
      
      {/* Listening indicator */}
      {(isListening || isTranscribing) && (
        <span className="flex items-center gap-1 text-xs">
          <span className="w-2 h-2 rounded-full bg-destructive animate-pulse" />
          {activeFieldId ? 'Receiving...' : 'No field'}
        </span>
      )}
    </div>
  );
}
