import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

interface PreviousVisit {
  id: string;
  date: string;
  chiefComplaint: string;
  noteType: string;
  summary?: string;
  content: string;
}

interface ChronicCondition {
  id: string;
  condition_name: string;
  icd_code?: string;
  is_chronic: boolean;
  notes?: string;
  onset_date?: string;
}

interface AIContextAnalysis {
  analysis: string;
  hasRelevantHistory: boolean;
}

export function usePreviousVisits(patientId: string | null) {
  const [previousVisits, setPreviousVisits] = useState<PreviousVisit[]>([]);
  const [chronicConditions, setChronicConditions] = useState<ChronicCondition[]>([]);
  const [aiContextAnalysis, setAiContextAnalysis] = useState<AIContextAnalysis | null>(null);
  const [isLoadingVisits, setIsLoadingVisits] = useState(false);
  const [isLoadingContext, setIsLoadingContext] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch previous visits when patient changes
  useEffect(() => {
    if (patientId) {
      fetchPreviousVisits(patientId);
      fetchChronicConditions(patientId);
    } else {
      setPreviousVisits([]);
      setChronicConditions([]);
      setAiContextAnalysis(null);
    }
  }, [patientId]);

  const fetchPreviousVisits = async (pid: string) => {
    setIsLoadingVisits(true);
    setError(null);

    try {
      // Get encounters with their notes for this patient
      const { data: encounters, error: encError } = await supabase
        .from('encounters')
        .select(`
          id,
          encounter_date,
          chief_complaint,
          status,
          notes (
            id,
            note_type,
            content,
            raw_content,
            created_at
          )
        `)
        .eq('patient_id', pid)
        .eq('status', 'completed')
        .order('encounter_date', { ascending: false })
        .limit(10);

      if (encError) throw encError;

      const visits: PreviousVisit[] = (encounters || []).flatMap(enc => 
        (enc.notes || []).map((note: any) => ({
          id: note.id,
          date: new Date(enc.encounter_date).toLocaleDateString(),
          chiefComplaint: enc.chief_complaint || 'Not specified',
          noteType: note.note_type,
          content: note.raw_content || JSON.stringify(note.content),
          summary: extractSummary(note.raw_content || ''),
        }))
      );

      setPreviousVisits(visits);
    } catch (err) {
      console.error('Error fetching previous visits:', err);
      setError('Failed to load previous visits');
    } finally {
      setIsLoadingVisits(false);
    }
  };

  const fetchChronicConditions = async (pid: string) => {
    try {
      const { data, error } = await supabase
        .from('problem_list')
        .select('*')
        .eq('patient_id', pid)
        .eq('status', 'active')
        .order('is_chronic', { ascending: false });

      if (error) throw error;
      setChronicConditions(data || []);
    } catch (err) {
      console.error('Error fetching chronic conditions:', err);
    }
  };

  // Smart automatic context - triggers when patient has chronic conditions
  const fetchSmartContext = useCallback(async (chiefComplaint: string) => {
    if (!patientId || chronicConditions.length === 0) {
      return;
    }

    // Only auto-fetch for chronic conditions
    const hasChronicCondition = chronicConditions.some(c => c.is_chronic);
    if (!hasChronicCondition) {
      return;
    }

    setIsLoadingContext(true);
    try {
      const patientNotes = previousVisits.map(v => ({
        date: v.date,
        type: v.noteType,
        chiefComplaint: v.chiefComplaint,
        content: v.content.substring(0, 2000), // Limit content size
      }));

      const { data, error } = await supabase.functions.invoke('search-patient-context', {
        body: {
          patientNotes,
          currentChiefComplaint: chiefComplaint,
          chronicConditions: chronicConditions.filter(c => c.is_chronic),
        }
      });

      if (error) throw error;

      setAiContextAnalysis({
        analysis: data?.analysis || '',
        hasRelevantHistory: data?.hasRelevantHistory || false,
      });
    } catch (err) {
      console.error('Error fetching AI context:', err);
    } finally {
      setIsLoadingContext(false);
    }
  }, [patientId, previousVisits, chronicConditions]);

  // Manual context search (for acute/new issues)
  const searchContextManually = async (chiefComplaint: string) => {
    if (!patientId) return;

    setIsLoadingContext(true);
    try {
      const patientNotes = previousVisits.map(v => ({
        date: v.date,
        type: v.noteType,
        chiefComplaint: v.chiefComplaint,
        content: v.content.substring(0, 2000),
      }));

      const { data, error } = await supabase.functions.invoke('search-patient-context', {
        body: {
          patientNotes,
          currentChiefComplaint: chiefComplaint,
          chronicConditions,
        }
      });

      if (error) throw error;

      setAiContextAnalysis({
        analysis: data?.analysis || '',
        hasRelevantHistory: data?.hasRelevantHistory || false,
      });
    } catch (err) {
      console.error('Error searching context:', err);
      setError('Failed to search patient context');
    } finally {
      setIsLoadingContext(false);
    }
  };

  const clearContext = () => {
    setAiContextAnalysis(null);
  };

  return {
    previousVisits,
    chronicConditions,
    aiContextAnalysis,
    isLoadingVisits,
    isLoadingContext,
    error,
    fetchSmartContext,
    searchContextManually,
    clearContext,
  };
}

// Helper to extract a brief summary from note content
function extractSummary(content: string): string {
  if (!content) return '';
  
  // Try to find Assessment section
  const assessmentMatch = content.match(/(?:Assessment|Impression|Diagnosis)[:\s]*([^\n]+)/i);
  if (assessmentMatch) {
    return assessmentMatch[1].trim().substring(0, 150);
  }
  
  // Fallback to first meaningful line
  const lines = content.split('\n').filter(l => l.trim().length > 10);
  return lines[0]?.substring(0, 150) || '';
}