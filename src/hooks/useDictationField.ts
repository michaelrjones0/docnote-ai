/**
 * useDictationField - Register a textarea for global dictation
 * 
 * Call this hook in any component with a textarea to make it
 * a target for global dictation. When the field is focused and
 * dictation is active, transcribed text will be inserted at the cursor.
 */

import { useEffect, useCallback, useRef } from "react";
import { useDictationContext } from "@/contexts/DictationContext";

interface UseDictationFieldOptions {
  id: string;
  value: string;
  onChange: (value: string) => void;
}

export function useDictationField({ id, value, onChange }: UseDictationFieldOptions) {
  const { registerField, unregisterField, setActiveFieldId, activeFieldId, status } = useDictationContext();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const valueRef = useRef(value);
  
  // Keep valueRef in sync
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  // Register field on mount
  useEffect(() => {
    registerField({
      id,
      getElement: () => textareaRef.current,
      onInsert: (newValue: string) => {
        onChange(newValue);
      },
    });

    return () => {
      unregisterField(id);
    };
  }, [id, registerField, unregisterField, onChange]);

  // Handle focus to set active field
  const handleFocus = useCallback(() => {
    setActiveFieldId(id);
  }, [id, setActiveFieldId]);

  // Handle blur - only clear if not dictating
  const handleBlur = useCallback(() => {
    // Don't clear active field if dictation is active
    // This allows clicking the dictation button without losing focus
    if (status === "idle") {
      setActiveFieldId(null);
    }
  }, [status, setActiveFieldId]);

  const isReceiving = activeFieldId === id && status === "listening";

  return {
    textareaRef,
    handleFocus,
    handleBlur,
    isReceiving,
    isActive: activeFieldId === id,
  };
}
