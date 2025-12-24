import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

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
      const { data, error: fnError } = await supabase.functions.invoke('generate-note', {
        body: params
      });

      if (fnError) {
        throw fnError;
      }

      if (data?.error) {
        throw new Error(data.error);
      }

      const note = data?.note || '';
      setGeneratedNote(note);
      return note;

    } catch (err) {
      console.error('Note generation error:', err);
      const errorMessage = err instanceof Error ? err.message : 'Failed to generate note';
      setError(errorMessage);
      throw err;
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