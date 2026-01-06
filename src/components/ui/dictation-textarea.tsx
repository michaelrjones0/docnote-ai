/**
 * DictationTextarea - AutoResizeTextarea with integrated dictation toggle.
 * 
 * Features:
 * - Mic button in header area for each field
 * - Toggle on/off (not press-and-hold)
 * - Shows "Listening…" and "Transcribing…" states
 * - Inserts at cursor position or appends with smart spacing
 * - Only one field can listen at a time (enforced by useFieldDictation)
 */

import * as React from 'react';
import { Mic, MicOff, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AutoResizeTextarea, AutoResizeTextareaProps } from '@/components/ui/auto-resize-textarea';
import { useFieldDictation, DictationStatus } from '@/hooks/useFieldDictation';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

interface DictationTextareaProps extends Omit<AutoResizeTextareaProps, 'onCopy'> {
  fieldId: string;
  label: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  copyButton?: React.ReactNode;
}

export const DictationTextarea = React.forwardRef<HTMLTextAreaElement, DictationTextareaProps>(
  ({ fieldId, label, value, onChange, copyButton, className, ...props }, ref) => {
    const { toast } = useToast();
    const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
    const cursorPositionRef = React.useRef<number | null>(null);

    // Track cursor position on blur/selection change
    const handleSelectionChange = React.useCallback(() => {
      if (textareaRef.current) {
        cursorPositionRef.current = textareaRef.current.selectionStart;
      }
    }, []);

    // Handle text insertion from dictation
    const handleInsertText = React.useCallback((text: string) => {
      const textarea = textareaRef.current;
      const currentValue = value || '';
      let insertPosition = cursorPositionRef.current;
      
      // Default to end if no cursor position
      if (insertPosition === null || insertPosition === undefined) {
        insertPosition = currentValue.length;
      }

      // Smart spacing: add space/newline if needed
      let formattedText = text;
      if (insertPosition > 0) {
        const charBefore = currentValue[insertPosition - 1];
        if (charBefore && !charBefore.match(/\s/)) {
          // Add space if previous char is not whitespace
          formattedText = ' ' + formattedText;
        }
      }
      if (insertPosition < currentValue.length) {
        const charAfter = currentValue[insertPosition];
        if (charAfter && !charAfter.match(/\s/)) {
          // Add space if next char is not whitespace
          formattedText = formattedText + ' ';
        }
      }

      // Create new value with inserted text
      const newValue = 
        currentValue.slice(0, insertPosition) + 
        formattedText + 
        currentValue.slice(insertPosition);

      // Create synthetic event
      const syntheticEvent = {
        target: { value: newValue },
        currentTarget: { value: newValue },
      } as React.ChangeEvent<HTMLTextAreaElement>;

      onChange(syntheticEvent);

      // Update cursor position for next dictation
      cursorPositionRef.current = insertPosition + formattedText.length;
    }, [value, onChange]);

    // Handle errors
    const handleError = React.useCallback((error: string) => {
      toast({
        title: 'Dictation Error',
        description: error,
        variant: 'destructive',
      });
    }, [toast]);

    const { status, toggle } = useFieldDictation({
      fieldId,
      onInsertText: handleInsertText,
      onError: handleError,
    });

    // Combine refs
    const setRefs = React.useCallback((node: HTMLTextAreaElement | null) => {
      textareaRef.current = node;
      if (typeof ref === 'function') {
        ref(node);
      } else if (ref) {
        ref.current = node;
      }
    }, [ref]);

    // Get status display
    const getStatusBadge = () => {
      switch (status) {
        case 'listening':
          return (
            <span className="flex items-center gap-1 text-xs text-destructive font-medium animate-pulse">
              <span className="w-2 h-2 rounded-full bg-destructive animate-pulse" />
              Listening…
            </span>
          );
        case 'transcribing':
          return (
            <span className="flex items-center gap-1 text-xs text-primary font-medium">
              <Loader2 className="h-3 w-3 animate-spin" />
              Transcribing…
            </span>
          );
        default:
          return null;
      }
    };

    const getMicButton = () => {
      const isListening = status === 'listening';
      const isTranscribing = status === 'transcribing';
      const isDisabled = isTranscribing;

      return (
        <Button
          type="button"
          variant={isListening ? 'destructive' : 'ghost'}
          size="sm"
          onClick={toggle}
          disabled={isDisabled}
          className={cn(
            'h-7 w-7 p-0',
            isListening && 'animate-pulse'
          )}
          title={isListening ? 'Stop dictation' : 'Start dictation'}
        >
          {isListening ? (
            <MicOff className="h-3.5 w-3.5" />
          ) : isTranscribing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Mic className="h-3.5 w-3.5" />
          )}
        </Button>
      );
    };

    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {getMicButton()}
            <span className="font-semibold text-sm text-primary uppercase tracking-wide">
              {label}
            </span>
            {getStatusBadge()}
          </div>
          {copyButton}
        </div>
        <AutoResizeTextarea
          ref={setRefs}
          value={value}
          onChange={onChange}
          onBlur={handleSelectionChange}
          onClick={handleSelectionChange}
          onKeyUp={handleSelectionChange}
          className={cn(
            status === 'listening' && 'ring-2 ring-destructive ring-offset-1',
            className
          )}
          {...props}
        />
      </div>
    );
  }
);

DictationTextarea.displayName = 'DictationTextarea';
