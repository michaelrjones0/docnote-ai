/**
 * DictationTextarea - AutoResizeTextarea that registers with global dictation.
 * 
 * Features:
 * - Registers/unregisters with DictationContext for focus tracking
 * - Shows subtle highlight when receiving dictation
 * - NO per-field mic button - uses global mic instead
 * 
 * ============================================================================
 * DICTATION SMOKE TEST CHECKLIST:
 * ============================================================================
 * 1. Global mic ON → focus this field → speak → text appears here.
 * 2. Switch focus to another field while mic is on → text goes to new field.
 * 3. Click in middle of existing text, dictate → insertion at cursor (not append).
 * 4. No console/network logs include transcript text or base64 audio data.
 * ============================================================================
 */

import * as React from 'react';
import { AutoResizeTextarea, AutoResizeTextareaProps } from '@/components/ui/auto-resize-textarea';
import { useDictationContext } from '@/contexts/DictationContext';
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
    const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
    const cursorPositionRef = React.useRef<number | null>(null);
    const valueRef = React.useRef(value);
    
    // Keep value ref updated
    React.useEffect(() => {
      valueRef.current = value;
    }, [value]);

    const { 
      registerField, 
      unregisterField, 
      setActiveField, 
      activeFieldId, 
      isDictating 
    } = useDictationContext();

    // Register field with context
    React.useEffect(() => {
      const registration = {
        fieldId,
        getValue: () => valueRef.current,
        setValue: (newValue: string) => {
          const syntheticEvent = {
            target: { value: newValue },
            currentTarget: { value: newValue },
          } as React.ChangeEvent<HTMLTextAreaElement>;
          onChange(syntheticEvent);
        },
        getSelectionStart: () => cursorPositionRef.current,
        setSelectionStart: (pos: number) => {
          cursorPositionRef.current = pos;
        },
      };

      registerField(registration);

      return () => {
        unregisterField(fieldId);
      };
    }, [fieldId, registerField, unregisterField, onChange]);

    // Track cursor position
    const handleSelectionChange = React.useCallback(() => {
      if (textareaRef.current) {
        cursorPositionRef.current = textareaRef.current.selectionStart;
      }
    }, []);

    // Handle focus
    const handleFocus = React.useCallback(() => {
      setActiveField(fieldId);
      handleSelectionChange();
    }, [fieldId, setActiveField, handleSelectionChange]);

    // Handle blur - keep last active for a moment
    const handleBlur = React.useCallback(() => {
      // Don't immediately clear - let context handle via lastActiveFieldIdRef
      handleSelectionChange();
    }, [handleSelectionChange]);

    // Combine refs
    const setRefs = React.useCallback((node: HTMLTextAreaElement | null) => {
      textareaRef.current = node;
      if (typeof ref === 'function') {
        ref(node);
      } else if (ref) {
        ref.current = node;
      }
    }, [ref]);

    // Is this field receiving dictation?
    const isReceivingDictation = isDictating && activeFieldId === fieldId;

    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm text-primary uppercase tracking-wide">
              {label}
            </span>
            {isReceivingDictation && (
              <span className="flex items-center gap-1 text-xs text-destructive font-medium animate-pulse">
                <span className="w-2 h-2 rounded-full bg-destructive animate-pulse" />
                Receiving…
              </span>
            )}
          </div>
          {copyButton}
        </div>
        <AutoResizeTextarea
          ref={setRefs}
          value={value}
          onChange={(e) => {
            onChange(e);
            handleSelectionChange();
          }}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onClick={handleSelectionChange}
          onKeyUp={handleSelectionChange}
          className={cn(
            isReceivingDictation && 'ring-2 ring-destructive ring-offset-1',
            className
          )}
          {...props}
        />
      </div>
    );
  }
);

DictationTextarea.displayName = 'DictationTextarea';
