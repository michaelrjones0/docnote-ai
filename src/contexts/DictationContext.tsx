/**
 * DictationContext - Global focus registry for dictation.
 * 
 * Tracks which textarea is currently focused so global dictation
 * can insert text into the right field.
 * 
 * ============================================================================
 * DICTATION SMOKE TEST CHECKLIST (run manually before adding new features):
 * ============================================================================
 * 1. Start global mic → speak → text appears in focused field.
 * 2. Switch focus to another field while mic is on → text goes to new field.
 * 3. Click in middle of existing text, dictate → insertion at cursor (not append).
 * 4. No console/network logs include transcript text or base64 audio data.
 * 5. If no field focused, toast "Click into a field to dictate."
 * ============================================================================
 */

import React, { createContext, useContext, useCallback, useRef, useState } from 'react';

export interface FieldRegistration {
  fieldId: string;
  getValue: () => string;
  setValue: (value: string) => void;
  getSelectionStart: () => number | null;
  setSelectionStart: (pos: number) => void;
}

interface DictationContextValue {
  // Register a field when it exists in DOM
  registerField: (field: FieldRegistration) => void;
  unregisterField: (fieldId: string) => void;
  
  // Track focus
  setActiveField: (fieldId: string | null) => void;
  activeFieldId: string | null;
  
  // Get the current active field for insertion
  getActiveField: () => FieldRegistration | null;
  
  // Insert text at cursor in active field
  insertText: (text: string) => boolean;
  
  // Global dictation state (managed by useGlobalDictation)
  isDictating: boolean;
  setIsDictating: (value: boolean) => void;
}

const DictationContext = createContext<DictationContextValue | null>(null);

export function DictationProvider({ children }: { children: React.ReactNode }) {
  const fieldsRef = useRef<Map<string, FieldRegistration>>(new Map());
  const [activeFieldId, setActiveFieldIdState] = useState<string | null>(null);
  const [isDictating, setIsDictating] = useState(false);
  const lastActiveFieldIdRef = useRef<string | null>(null);

  const registerField = useCallback((field: FieldRegistration) => {
    fieldsRef.current.set(field.fieldId, field);
  }, []);

  const unregisterField = useCallback((fieldId: string) => {
    fieldsRef.current.delete(fieldId);
    if (activeFieldId === fieldId) {
      // Don't null immediately - keep lastActive
      lastActiveFieldIdRef.current = fieldId;
    }
  }, [activeFieldId]);

  const setActiveField = useCallback((fieldId: string | null) => {
    if (fieldId) {
      lastActiveFieldIdRef.current = fieldId;
    }
    setActiveFieldIdState(fieldId);
  }, []);

  const getActiveField = useCallback((): FieldRegistration | null => {
    // Prefer current active, fall back to last active
    const targetId = activeFieldId || lastActiveFieldIdRef.current;
    if (!targetId) return null;
    return fieldsRef.current.get(targetId) || null;
  }, [activeFieldId]);

  const insertText = useCallback((text: string): boolean => {
    const field = getActiveField();
    if (!field) return false;

    const currentValue = field.getValue();
    let insertPosition = field.getSelectionStart();
    
    // Default to end if no cursor position
    if (insertPosition === null || insertPosition === undefined) {
      insertPosition = currentValue.length;
    }

    // Smart spacing: add space/newline if needed
    let formattedText = text;
    if (insertPosition > 0) {
      const charBefore = currentValue[insertPosition - 1];
      if (charBefore && !charBefore.match(/\s/)) {
        formattedText = ' ' + formattedText;
      }
    }
    if (insertPosition < currentValue.length) {
      const charAfter = currentValue[insertPosition];
      if (charAfter && !charAfter.match(/\s/)) {
        formattedText = formattedText + ' ';
      }
    }

    // Create new value with inserted text
    const newValue = 
      currentValue.slice(0, insertPosition) + 
      formattedText + 
      currentValue.slice(insertPosition);

    field.setValue(newValue);
    
    // Update cursor position for next insertion
    const newCursorPos = insertPosition + formattedText.length;
    field.setSelectionStart(newCursorPos);

    return true;
  }, [getActiveField]);

  const value: DictationContextValue = {
    registerField,
    unregisterField,
    setActiveField,
    activeFieldId,
    getActiveField,
    insertText,
    isDictating,
    setIsDictating,
  };

  return (
    <DictationContext.Provider value={value}>
      {children}
    </DictationContext.Provider>
  );
}

export function useDictationContext() {
  const context = useContext(DictationContext);
  if (!context) {
    throw new Error('useDictationContext must be used within DictationProvider');
  }
  return context;
}
