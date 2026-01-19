import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { safeErrorLog } from '@/lib/debug';

export type NoteType = 'SOAP' | 'H&P' | 'Progress' | 'Procedure';

interface GenerateNoteParams {
  noteType: NoteType;
  transcript: string;
  chiefComplaint?: string;
  patientContext?: string;
  previousVisits?: Array<{
    date: string;
    chiefComplaint: string;
    summary?: string;
  }>;
  chronicConditions?: Array<{
    condition_name: string;
    icd_code?: string;
    notes?: string;
  }>;
}

export function useNoteGeneration() {
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedNote, setGeneratedNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const generateNote = useCallback(async (params: GenerateNoteParams): Promise<string> => {
    setIsGenerating(true);
    setError(null);

    try {
      console.log('[useNoteGeneration] Invoking generate-note with params:', {
        noteType: params.noteType,
        transcriptLength: params.transcript?.length,
      });

      const { data, error: fnError } = await supabase.functions.invoke('generate-note', {
        body: params
      });

      console.log('[useNoteGeneration] Response received:', {
        hasData: !!data,
        hasNote: !!data?.note,
        hasMarkdown: !!data?.markdown,
        hasSoap: !!data?.soap,
        error: fnError,
      });

      if (fnError) {
        throw fnError;
      }

      if (data?.error) {
        throw new Error(data.error);
      }

      // Handle different response formats:
      // - SOAP notes return: { note, markdown, soap }
      // - Non-SOAP notes return: { note, noteType }
      const note = data?.markdown || data?.note || '';
      
      if (!note) {
        console.error('[useNoteGeneration] No note content in response:', data);
        throw new Error('No note content received from server');
      }

      console.log('[useNoteGeneration] Setting generatedNote, length:', note.length);
      setGeneratedNote(note);
      return note;

    } catch (err) {
      safeErrorLog('[NoteGeneration] Error:', err);
      const errorMessage = err instanceof Error ? err.message : 'Failed to generate note';
      // Map auth errors to user-friendly messages
      const userMessage = /unauthorized|401|invalid.*token|expired/i.test(errorMessage)
        ? 'Session expired. Please log in again.'
        : errorMessage;
      setError(userMessage);
      throw new Error(userMessage);
    } finally {
      setIsGenerating(false);
    }
  }, []);

  const clearNote = useCallback(() => {
    setGeneratedNote(null);
    setError(null);
  }, []);

  return {
    isGenerating,
    generatedNote,
    error,
    generateNote,
    clearNote,
    setGeneratedNote,
  };
}
