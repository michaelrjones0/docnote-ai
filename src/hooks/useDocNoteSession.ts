import { useState, useEffect, useCallback, useRef } from 'react';

// =====================================================
// 4-field SOAP data (S, O, A, P separate)
// =====================================================
interface SoapData {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
}

// =====================================================
// 3-field SOAP data (S, O, A/P combined)
// =====================================================
interface Soap3Data {
  subjective: string;
  objective: string;
  assessmentPlan: string;
}

interface ApEntry {
  problem: string;
  assessment: string;
  plan: string[];
}

// =====================================================
// Generated note can be either 4-field or 3-field
// =====================================================
interface GeneratedNote4Field {
  noteType: 'SOAP_4_FIELD' | 'SOAP';
  soap: SoapData;
  markdown: string;
  patientInstructions?: string;
}

interface GeneratedNote3Field {
  noteType: 'SOAP_3_FIELD';
  soap3: Soap3Data;
  ap: ApEntry[];
  markdown: string;
  patientInstructions?: string;
}

type GeneratedNote = GeneratedNote4Field | GeneratedNote3Field;

export type LiveDraftMode = 'A' | 'B';

export interface DocNoteSession {
  jobName: string | null;
  transcriptText: string | null;
  generated: GeneratedNote | null;
  edited: GeneratedNote | null;
  updatedAt: string;
  markdownExpanded: boolean;
  liveDraftMode: LiveDraftMode;
  runningSummary: string | null;
  summaryUpdatedAt: string | null;
}

const STORAGE_KEY = 'docnoteai_session';

const getEmptySession = (): DocNoteSession => ({
  jobName: null,
  transcriptText: null,
  generated: null,
  edited: null,
  updatedAt: new Date().toISOString(),
  markdownExpanded: false,
  liveDraftMode: 'A',
  runningSummary: null,
  summaryUpdatedAt: null,
});

const loadSession = (): DocNoteSession => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      return {
        jobName: parsed.jobName ?? null,
        transcriptText: parsed.transcriptText ?? null,
        generated: parsed.generated ?? null,
        edited: parsed.edited ?? null,
        updatedAt: parsed.updatedAt ?? new Date().toISOString(),
        markdownExpanded: parsed.markdownExpanded ?? false,
        liveDraftMode: parsed.liveDraftMode ?? 'A',
        runningSummary: parsed.runningSummary ?? null,
        summaryUpdatedAt: parsed.summaryUpdatedAt ?? null,
      };
    }
  } catch (e) {
    console.error('Failed to load session from localStorage:', e);
  }
  return getEmptySession();
};

const saveSession = (session: DocNoteSession): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...session,
      updatedAt: new Date().toISOString(),
    }));
  } catch (e) {
    console.error('Failed to save session to localStorage:', e);
  }
};

// =====================================================
// Type guards for note types
// =====================================================
export const isNote4Field = (note: GeneratedNote | null): note is GeneratedNote4Field => {
  if (!note) return false;
  return note.noteType === 'SOAP_4_FIELD' || note.noteType === 'SOAP' || 'soap' in note;
};

export const isNote3Field = (note: GeneratedNote | null): note is GeneratedNote3Field => {
  if (!note) return false;
  return note.noteType === 'SOAP_3_FIELD' || 'soap3' in note;
};

export const useDocNoteSession = () => {
  const [session, setSession] = useState<DocNoteSession>(getEmptySession);
  const [pendingGenerated, setPendingGenerated] = useState<GeneratedNote | null>(null);
  const [showConflictBanner, setShowConflictBanner] = useState(false);
  const [modeMismatchWarning, setModeMismatchWarning] = useState<string | null>(null);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const initialLoadDone = useRef(false);

  // Hydrate on first render
  useEffect(() => {
    if (!initialLoadDone.current) {
      const loaded = loadSession();
      setSession(loaded);
      initialLoadDone.current = true;
    }
  }, []);

  // Autosave with debounce
  const persistSession = useCallback((newSession: DocNoteSession) => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      saveSession(newSession);
    }, 300);
  }, []);

  const updateSession = useCallback((updates: Partial<DocNoteSession>) => {
    setSession(prev => {
      const newSession = { ...prev, ...updates };
      persistSession(newSession);
      return newSession;
    });
  }, [persistSession]);

  const setJobName = useCallback((jobName: string | null) => {
    updateSession({ jobName });
  }, [updateSession]);

  const setTranscriptText = useCallback((transcriptText: string | null) => {
    updateSession({ transcriptText });
  }, [updateSession]);

  const setMarkdownExpanded = useCallback((markdownExpanded: boolean) => {
    updateSession({ markdownExpanded });
  }, [updateSession]);

  const setLiveDraftMode = useCallback((liveDraftMode: LiveDraftMode) => {
    updateSession({ liveDraftMode });
  }, [updateSession]);

  const setRunningSummary = useCallback((runningSummary: string | null) => {
    updateSession({ runningSummary, summaryUpdatedAt: new Date().toISOString() });
  }, [updateSession]);

  // Clear mode mismatch warning
  const clearModeMismatchWarning = useCallback(() => {
    setModeMismatchWarning(null);
  }, []);

  // Check if user has made edits
  const hasUserEdits = useCallback((): boolean => {
    if (!session.edited || !session.generated) return false;
    return JSON.stringify(session.edited) !== JSON.stringify(session.generated);
  }, [session.edited, session.generated]);

  // Handle new generated note with mode validation
  const handleNewGenerated = useCallback((generated: GeneratedNote, expectedMode?: 'SOAP_4_FIELD' | 'SOAP_3_FIELD') => {
    // Check for mode mismatch if expectedMode is provided
    if (expectedMode) {
      const responseIs4Field = isNote4Field(generated);
      const expected4Field = expectedMode === 'SOAP_4_FIELD';
      
      if (responseIs4Field !== expected4Field) {
        setModeMismatchWarning(
          `Warning: Expected ${expectedMode} but received ${generated.noteType}. Fields may not display correctly.`
        );
        // Still allow the note to be set, but warn user
      } else {
        setModeMismatchWarning(null);
      }
    }

    if (session.edited && hasUserEdits()) {
      // User has edits, show conflict banner
      setPendingGenerated(generated);
      setShowConflictBanner(true);
    } else {
      // No edits or edited matches generated, just replace both
      updateSession({ generated, edited: generated });
    }
  }, [session.edited, hasUserEdits, updateSession]);

  const acceptNewGenerated = useCallback(() => {
    if (pendingGenerated) {
      updateSession({ generated: pendingGenerated, edited: pendingGenerated });
      setPendingGenerated(null);
      setShowConflictBanner(false);
    }
  }, [pendingGenerated, updateSession]);

  const keepUserEdits = useCallback(() => {
    if (pendingGenerated) {
      updateSession({ generated: pendingGenerated });
      setPendingGenerated(null);
      setShowConflictBanner(false);
    }
  }, [pendingGenerated, updateSession]);

  // =====================================================
  // 4-FIELD SOAP helpers
  // =====================================================
  const buildMarkdownFromSoap4 = (soap: SoapData): string => {
    return `## Subjective
${soap.subjective || 'Not documented.'}

## Objective
${soap.objective || 'Not documented.'}

## Assessment
${soap.assessment || 'Not documented.'}

## Plan
${soap.plan || 'Not documented.'}`;
  };

  const editSoapField = useCallback((field: keyof SoapData, value: string) => {
    setSession(prev => {
      const baseNote = prev.edited ?? prev.generated;
      if (!baseNote || !isNote4Field(baseNote)) return prev;
      
      const newSoap: SoapData = {
        ...baseNote.soap,
        [field]: value,
      };
      
      const newEdited: GeneratedNote4Field = {
        ...baseNote,
        soap: newSoap,
        markdown: buildMarkdownFromSoap4(newSoap),
      };
      
      const newSession = { ...prev, edited: newEdited };
      persistSession(newSession);
      return newSession;
    });
  }, [persistSession]);

  const syncMarkdownFromSoap = useCallback(() => {
    setSession(prev => {
      const baseNote = prev.edited ?? prev.generated;
      if (!baseNote || !isNote4Field(baseNote)) return prev;
      
      const markdown = buildMarkdownFromSoap4(baseNote.soap);
      
      const newEdited: GeneratedNote4Field = {
        ...baseNote,
        markdown,
      };
      
      const newSession = { ...prev, edited: newEdited };
      persistSession(newSession);
      return newSession;
    });
  }, [persistSession]);

  const getCurrentSoap = useCallback((): SoapData | null => {
    const note = session.edited ?? session.generated;
    if (note && isNote4Field(note)) {
      return note.soap;
    }
    return null;
  }, [session.edited, session.generated]);

  // =====================================================
  // 3-FIELD SOAP helpers
  // =====================================================
  const buildMarkdownFromSoap3 = (soap3: Soap3Data): string => {
    return `## Subjective
${soap3.subjective || 'Not documented.'}

## Objective
${soap3.objective || 'Not documented.'}

## Assessment & Plan
${soap3.assessmentPlan || 'Not documented.'}`;
  };

  const editSoap3Field = useCallback((field: keyof Soap3Data, value: string) => {
    setSession(prev => {
      const baseNote = prev.edited ?? prev.generated;
      if (!baseNote || !isNote3Field(baseNote)) return prev;
      
      const newSoap3: Soap3Data = {
        ...baseNote.soap3,
        [field]: value,
      };
      
      const newEdited: GeneratedNote3Field = {
        ...baseNote,
        soap3: newSoap3,
        markdown: buildMarkdownFromSoap3(newSoap3),
      };
      
      const newSession = { ...prev, edited: newEdited };
      persistSession(newSession);
      return newSession;
    });
  }, [persistSession]);

  const syncMarkdownFromSoap3 = useCallback(() => {
    setSession(prev => {
      const baseNote = prev.edited ?? prev.generated;
      if (!baseNote || !isNote3Field(baseNote)) return prev;
      
      const markdown = buildMarkdownFromSoap3(baseNote.soap3);
      
      const newEdited: GeneratedNote3Field = {
        ...baseNote,
        markdown,
      };
      
      const newSession = { ...prev, edited: newEdited };
      persistSession(newSession);
      return newSession;
    });
  }, [persistSession]);

  const getCurrentSoap3 = useCallback((): Soap3Data | null => {
    const note = session.edited ?? session.generated;
    if (note && isNote3Field(note)) {
      return note.soap3;
    }
    return null;
  }, [session.edited, session.generated]);

  const getCurrentAp = useCallback((): ApEntry[] => {
    const note = session.edited ?? session.generated;
    if (note && isNote3Field(note)) {
      return note.ap || [];
    }
    return [];
  }, [session.edited, session.generated]);

  // =====================================================
  // Common helpers
  // =====================================================
  const clearSession = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
      console.error('Failed to clear session from localStorage:', e);
    }
    setSession(getEmptySession());
    setPendingGenerated(null);
    setShowConflictBanner(false);
    setModeMismatchWarning(null);
  }, []);

  const getCurrentMarkdown = useCallback((): string => {
    const note = session.edited ?? session.generated;
    if (!note) return '';
    
    // For 4-field, rebuild from edited fields to capture changes
    if (isNote4Field(note)) {
      return buildMarkdownFromSoap4(note.soap);
    }
    // For 3-field, rebuild from edited fields to capture changes
    if (isNote3Field(note)) {
      return buildMarkdownFromSoap3(note.soap3);
    }
    // Fallback - should not reach here with proper typing
    return '';
  }, [session.edited, session.generated]);

  const getExportJson = useCallback((): string => {
    const data = session.edited ?? session.generated;
    return data ? JSON.stringify(data, null, 2) : '';
  }, [session.edited, session.generated]);

  // Get current note type
  const getCurrentNoteType = useCallback((): 'SOAP_4_FIELD' | 'SOAP_3_FIELD' | null => {
    const note = session.edited ?? session.generated;
    if (!note) return null;
    if (isNote4Field(note)) return 'SOAP_4_FIELD';
    if (isNote3Field(note)) return 'SOAP_3_FIELD';
    return null;
  }, [session.edited, session.generated]);

  // Get patient instructions from the current note
  const getPatientInstructions = useCallback((): string => {
    const note = session.edited ?? session.generated;
    if (!note) return '';
    return note.patientInstructions || '';
  }, [session.edited, session.generated]);

  // Edit patient instructions
  const editPatientInstructions = useCallback((value: string) => {
    setSession(prev => {
      const baseNote = prev.edited ?? prev.generated;
      if (!baseNote) return prev;
      
      const newEdited = {
        ...baseNote,
        patientInstructions: value,
      };
      
      const newSession = { ...prev, edited: newEdited };
      persistSession(newSession);
      return newSession;
    });
  }, [persistSession]);

  return {
    session,
    showConflictBanner,
    pendingGenerated,
    modeMismatchWarning,
    setJobName,
    setTranscriptText,
    setMarkdownExpanded,
    setLiveDraftMode,
    setRunningSummary,
    handleNewGenerated,
    acceptNewGenerated,
    keepUserEdits,
    clearModeMismatchWarning,
    // 4-field helpers
    editSoapField,
    syncMarkdownFromSoap,
    getCurrentSoap,
    // 3-field helpers
    editSoap3Field,
    syncMarkdownFromSoap3,
    getCurrentSoap3,
    getCurrentAp,
    // Common helpers
    clearSession,
    getCurrentMarkdown,
    getExportJson,
    getCurrentNoteType,
    getPatientInstructions,
    editPatientInstructions,
    // Type guards
    isNote4Field,
    isNote3Field,
  };
};
