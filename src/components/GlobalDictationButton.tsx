/**
 * GlobalDictationButton - Toggle button for global dictation
 * 
 * Uses Deepgram for real-time STT. Shows status indicator
 * and prevents focus loss when clicked.
 */

import React from "react";
import { Mic, MicOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDeepgramDictation } from "@/hooks/useDeepgramDictation";
import { useDictationContext } from "@/contexts/DictationContext";
import { cn } from "@/lib/utils";

export function GlobalDictationButton() {
  const { status, activeFieldId, engine } = useDictationContext();
  const { toggle } = useDeepgramDictation();

  // Prevent focus loss when clicking
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
  };

  const isIdle = status === "idle";
  const isConnecting = status === "connecting";
  const isListening = status === "listening";
  const isTranscribing = status === "transcribing";

  const getStatusColor = () => {
    if (isListening) return "bg-green-500";
    if (isConnecting || isTranscribing) return "bg-yellow-500";
    return "bg-muted";
  };

  const getButtonLabel = () => {
    if (isConnecting) return "Connecting...";
    if (isListening) return "Stop Dictation";
    if (isTranscribing) return "Processing...";
    return "Dictate";
  };

  return (
    <div className="flex items-center gap-2">
      <Button
        variant={isIdle ? "outline" : "destructive"}
        size="sm"
        onClick={toggle}
        onMouseDown={handleMouseDown}
        onPointerDown={handlePointerDown}
        className={cn(
          "min-w-[120px]",
          isListening && "animate-pulse"
        )}
      >
        {isConnecting || isTranscribing ? (
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        ) : isListening ? (
          <MicOff className="h-4 w-4 mr-2" />
        ) : (
          <Mic className="h-4 w-4 mr-2" />
        )}
        {getButtonLabel()}
      </Button>
      
      {/* Status indicator */}
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <div className={cn("h-2 w-2 rounded-full", getStatusColor())} />
        <span className="capitalize">{engine}</span>
      </div>
      
      {/* Active field indicator */}
      {activeFieldId && status !== "idle" && (
        <span className="text-xs text-muted-foreground">
          → {activeFieldId}
        </span>
      )}
    </div>
  );
}
