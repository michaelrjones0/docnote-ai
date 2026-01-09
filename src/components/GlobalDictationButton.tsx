/**
 * GlobalDictationButton - Main mic toggle for global dictation.
 * 
 * Uses the unified useDictation hook which selects implementation based on
 * VITE_DICTATION_ENGINE env flag (deepgram > streaming > batch).
 * 
 * Shows current engine indicator and connection health.
 * Automatic fallback to batch mode if Deepgram/streaming fails.
 */

import { Mic, MicOff, Loader2, Wifi, WifiOff, Radio, Database } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useDictation, DictationMode, isDictationEnabled } from '@/hooks/useDictation';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';

// Re-export for easy access
export { isDictationEnabled };

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
    fallbackReason,
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

  // Engine indicator with icon
  const getEngineIndicator = () => {
    const engineLabels: Record<DictationMode, { label: string; icon: React.ReactNode }> = {
      deepgram: { label: 'Deepgram', icon: <Radio className="h-3 w-3" /> },
      streaming: { label: 'AWS Stream', icon: <Wifi className="h-3 w-3" /> },
      batch: { label: 'Batch', icon: <Database className="h-3 w-3" /> },
    };

    const engine = engineLabels[mode];
    const isStreaming = mode === 'deepgram' || mode === 'streaming';
    
    // Color based on health for streaming modes
    let variant: 'default' | 'secondary' | 'destructive' | 'outline' = 'secondary';
    if (isActive && isStreaming) {
      if (streamHealth === 'online') variant = 'default';
      else if (streamHealth === 'connecting') variant = 'outline';
      else variant = 'destructive';
    }

    return (
      <Badge 
        variant={variant} 
        className={cn(
          'text-xs flex items-center gap-1 font-normal',
          fallbackReason && 'border-yellow-500'
        )}
        title={fallbackReason || `Engine: ${engine.label}`}
      >
        {engine.icon}
        {engine.label}
        {isActive && isStreaming && streamHealth && (
          <span className={cn(
            'ml-1',
            streamHealth === 'online' && 'text-green-400',
            streamHealth === 'connecting' && 'text-yellow-400',
            streamHealth === 'offline' && 'text-red-400'
          )}>
            •
          </span>
        )}
      </Badge>
    );
  };

  // If dictation is disabled, render nothing or a subtle indicator
  if (!isDictationEnabled()) {
    return null;
  }

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
      
      {/* Engine indicator */}
      {getEngineIndicator()}
      
      {/* Listening indicator */}
      {isActive && (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <span className="w-2 h-2 rounded-full bg-destructive animate-pulse" />
          {activeFieldId ? 'Receiving...' : 'No field'}
        </span>
      )}
    </div>
  );
}
