/**
 * DictationContext - Global dictation state management
 * 
 * Provides a focus registry for textarea fields and manages
 * the active dictation session. Text is inserted at cursor position
 * in the currently focused field.
 * 
 * Architecture:
 * - Each textarea registers via useDictationField hook
 * - GlobalDictationButton toggles recording
 * - Transcribed text is inserted at cursor in active field
 */

import React, { createContext, useContext, useRef, useState, useCallback, ReactNode } from "react";

export type DictationStatus = "idle" | "connecting" | "listening" | "transcribing";

interface FieldRegistration {
  id: string;
  getElement: () => HTMLTextAreaElement | null;
  onInsert: (text: string) => void;
}

interface DictationContextValue {
  // Status
  status: DictationStatus;
  setStatus: (status: DictationStatus) => void;
  
  // Active field tracking
  activeFieldId: string | null;
  setActiveFieldId: (id: string | null) => void;
  
  // Field registry
  registerField: (registration: FieldRegistration) => void;
  unregisterField: (id: string) => void;
  getActiveField: () => FieldRegistration | null;
  
  // Text insertion
  insertText: (text: string) => void;
  
  // Engine info
  engine: "deepgram" | "batch";
}

const DictationContext = createContext<DictationContextValue | null>(null);

export function DictationProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<DictationStatus>("idle");
  const [activeFieldId, setActiveFieldId] = useState<string | null>(null);
  const fieldsRef = useRef<Map<string, FieldRegistration>>(new Map());
  
  // Determine engine based on env (Deepgram preferred)
  const engine: "deepgram" | "batch" = "deepgram";

  const registerField = useCallback((registration: FieldRegistration) => {
    fieldsRef.current.set(registration.id, registration);
  }, []);

  const unregisterField = useCallback((id: string) => {
    fieldsRef.current.delete(id);
    if (activeFieldId === id) {
      setActiveFieldId(null);
    }
  }, [activeFieldId]);

  const getActiveField = useCallback((): FieldRegistration | null => {
    if (!activeFieldId) return null;
    return fieldsRef.current.get(activeFieldId) || null;
  }, [activeFieldId]);

  const insertText = useCallback((text: string) => {
    const field = getActiveField();
    if (!field) {
      console.warn("[Dictation] No active field for text insertion");
      return;
    }
    
    const el = field.getElement();
    if (!el) {
      console.warn("[Dictation] Field element not found");
      return;
    }

    // Insert at cursor position
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const before = el.value.substring(0, start);
    const after = el.value.substring(end);
    
    // Add space before if needed
    const needsSpace = before.length > 0 && !before.endsWith(" ") && !before.endsWith("\n");
    const insertedText = (needsSpace ? " " : "") + text;
    const newValue = before + insertedText + after;
    const newCursorPos = start + insertedText.length;

    // Call the field's onInsert to update React state
    field.onInsert(newValue);

    // Use requestAnimationFrame to ensure DOM is updated before setting selection
    requestAnimationFrame(() => {
      const currentEl = field.getElement();
      if (currentEl) {
        currentEl.focus();
        currentEl.setSelectionRange(newCursorPos, newCursorPos);
      }
    });
  }, [getActiveField]);

  return (
    <DictationContext.Provider
      value={{
        status,
        setStatus,
        activeFieldId,
        setActiveFieldId,
        registerField,
        unregisterField,
        getActiveField,
        insertText,
        engine,
      }}
    >
      {children}
    </DictationContext.Provider>
  );
}

export function useDictationContext(): DictationContextValue {
  const context = useContext(DictationContext);
  if (!context) {
    throw new Error("useDictationContext must be used within a DictationProvider");
  }
  return context;
}
