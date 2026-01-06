import { useState, useEffect, useCallback, useRef } from 'react';

interface SoapData {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
}

interface GeneratedNote {
  noteType: string;
  soap: SoapData;
  markdown: string;
}

export interface DocNoteSession {
  jobName: string | null;
  transcriptText: string | null;
  generated: GeneratedNote | null;
  edited: GeneratedNote | null;
  updatedAt: string;
  markdownExpanded: boolean;
}

const STORAGE_KEY = 'docnoteai_session';

const getEmptySession = (): DocNoteSession => ({
  jobName: null,
  transcriptText: null,
  generated: null,
  edited: null,
  updatedAt: new Date().toISOString(),
  markdownExpanded: false,
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

export const useDocNoteSession = () => {
  const [session, setSession] = useState<DocNoteSession>(getEmptySession);
  const [pendingGenerated, setPendingGenerated] = useState<GeneratedNote | null>(null);
  const [showConflictBanner, setShowConflictBanner] = useState(false);
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

  // Check if user has made edits
  const hasUserEdits = useCallback((): boolean => {
    if (!session.edited || !session.generated) return false;
    return JSON.stringify(session.edited) !== JSON.stringify(session.generated);
  }, [session.edited, session.generated]);

  // Handle new generated note
  const handleNewGenerated = useCallback((generated: GeneratedNote) => {
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

  // Edit a specific SOAP field
  const editSoapField = useCallback((field: keyof SoapData, value: string) => {
    setSession(prev => {
      const baseNote = prev.edited ?? prev.generated;
      if (!baseNote) return prev;
      
      const newEdited: GeneratedNote = {
        ...baseNote,
        soap: {
          ...baseNote.soap,
          [field]: value,
        },
      };
      
      const newSession = { ...prev, edited: newEdited };
      persistSession(newSession);
      return newSession;
    });
  }, [persistSession]);

  // Sync markdown from SOAP fields
  const syncMarkdownFromSoap = useCallback(() => {
    setSession(prev => {
      const baseNote = prev.edited ?? prev.generated;
      if (!baseNote) return prev;
      
      const markdown = `## Subjective
${baseNote.soap.subjective || 'Not documented.'}

## Objective
${baseNote.soap.objective || 'Not documented.'}

## Assessment
${baseNote.soap.assessment || 'Not documented.'}

## Plan
${baseNote.soap.plan || 'Not documented.'}`;
      
      const newEdited: GeneratedNote = {
        ...baseNote,
        markdown,
      };
      
      const newSession = { ...prev, edited: newEdited };
      persistSession(newSession);
      return newSession;
    });
  }, [persistSession]);

  // Clear session
  const clearSession = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
      console.error('Failed to clear session from localStorage:', e);
    }
    setSession(getEmptySession());
    setPendingGenerated(null);
    setShowConflictBanner(false);
  }, []);

  // Get current values for display/copy
  const getCurrentSoap = useCallback((): SoapData | null => {
    return session.edited?.soap ?? session.generated?.soap ?? null;
  }, [session.edited, session.generated]);

  const getCurrentMarkdown = useCallback((): string => {
    return session.edited?.markdown ?? session.generated?.markdown ?? '';
  }, [session.edited, session.generated]);

  const getExportJson = useCallback((): string => {
    const data = session.edited ?? session.generated;
    return data ? JSON.stringify(data, null, 2) : '';
  }, [session.edited, session.generated]);

  return {
    session,
    showConflictBanner,
    pendingGenerated,
    setJobName,
    setTranscriptText,
    setMarkdownExpanded,
    handleNewGenerated,
    acceptNewGenerated,
    keepUserEdits,
    editSoapField,
    syncMarkdownFromSoap,
    clearSession,
    getCurrentSoap,
    getCurrentMarkdown,
    getExportJson,
  };
};
