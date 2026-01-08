/**
 * GlobalDictationButton - Main mic toggle for global dictation.
 * 
 * Uses the unified useDictation hook which selects implementation based on
 * VITE_STREAMING_ENABLED env flag (defaults to batch mode).
 */

import { Mic, MicOff, Loader2, Wifi, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useDictation } from '@/hooks/useDictation';
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
    mode,
    streamHealth,
    partialText,
  } = useDictation({
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
  const isConnecting = status === 'connecting';
  const isStopping = status === 'stopping';
  const isActive = isListening || isTranscribing || isConnecting || isStopping;

  const getButtonContent = () => {
    if (isTranscribing) {
      return (
        <>
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          Transcribing…
        </>
      );
    }
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

  // Small streaming status indicator (only shown in streaming mode when active)
  const getStreamingIndicator = () => {
    if (mode !== 'streaming' || !isActive) return null;
    
    const statusClasses = {
      connecting: 'text-yellow-600',
      online: 'text-green-600',
      offline: 'text-destructive',
    };
    
    const StatusIcon = streamHealth === 'online' ? Wifi : WifiOff;
    
    return (
      <span className={cn('flex items-center gap-1 text-xs', statusClasses[streamHealth || 'offline'])}>
        <StatusIcon className="h-3 w-3" />
        {streamHealth}
      </span>
    );
  };

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Button
        type="button"
        variant={isActive ? 'destructive' : 'default'}
        size="sm"
        onClick={() => toggle()}
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
      {isActive && (
        <span className="flex items-center gap-1 text-xs">
          <span className="w-2 h-2 rounded-full bg-destructive animate-pulse" />
          {activeFieldId ? 'Receiving...' : 'No field'}
        </span>
      )}
      
      {/* Streaming status indicator */}
      {getStreamingIndicator()}
    </div>
  );
}
