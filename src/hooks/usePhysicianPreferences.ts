import { useState, useEffect, useCallback } from 'react';

export type NoteEditorMode = 'SOAP_4_FIELD' | 'SOAP_3_FIELD';

export interface PhysicianPreferences {
  noteStructure: 'SOAP' | 'Problem-Oriented';
  detailLevel: 'Brief' | 'Standard' | 'Detailed';
  planFormat: 'Bullets' | 'Paragraph';
  firstPerson: boolean;
  patientQuotes: boolean;
  styleText: string;
  assessmentProblemList: boolean;
  includeFollowUpLine: boolean;
  noteEditorMode: NoteEditorMode;
}

const STORAGE_KEY = 'docnoteai_preferences';
const MAX_STYLE_TEXT_LENGTH = 600;

const getDefaultPreferences = (): PhysicianPreferences => ({
  noteStructure: 'SOAP',
  detailLevel: 'Standard',
  planFormat: 'Bullets',
  firstPerson: false,
  patientQuotes: true,
  styleText: '',
  assessmentProblemList: true,
  includeFollowUpLine: true,
  noteEditorMode: 'SOAP_4_FIELD',
});

const loadPreferences = (): PhysicianPreferences => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      return {
        noteStructure: ['SOAP', 'Problem-Oriented'].includes(parsed.noteStructure)
          ? parsed.noteStructure
          : 'SOAP',
        detailLevel: ['Brief', 'Standard', 'Detailed'].includes(parsed.detailLevel) 
          ? parsed.detailLevel 
          : 'Standard',
        planFormat: ['Bullets', 'Paragraph'].includes(parsed.planFormat) 
          ? parsed.planFormat 
          : 'Bullets',
        firstPerson: typeof parsed.firstPerson === 'boolean' ? parsed.firstPerson : false,
        patientQuotes: typeof parsed.patientQuotes === 'boolean' ? parsed.patientQuotes : true,
        styleText: typeof parsed.styleText === 'string' 
          ? parsed.styleText.slice(0, MAX_STYLE_TEXT_LENGTH) 
          : '',
        assessmentProblemList: typeof parsed.assessmentProblemList === 'boolean' ? parsed.assessmentProblemList : true,
        includeFollowUpLine: typeof parsed.includeFollowUpLine === 'boolean' ? parsed.includeFollowUpLine : true,
        noteEditorMode: ['SOAP_4_FIELD', 'SOAP_3_FIELD'].includes(parsed.noteEditorMode)
          ? parsed.noteEditorMode
          : 'SOAP_4_FIELD',
      };
    }
  } catch (e) {
    console.error('Failed to load preferences from localStorage:', e);
  }
  return getDefaultPreferences();
};

const savePreferences = (prefs: PhysicianPreferences): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch (e) {
    console.error('Failed to save preferences to localStorage:', e);
  }
};

export const usePhysicianPreferences = () => {
  const [preferences, setPreferencesState] = useState<PhysicianPreferences>(getDefaultPreferences);

  useEffect(() => {
    const loaded = loadPreferences();
    setPreferencesState(loaded);
  }, []);

  const setPreferences = useCallback((updates: Partial<PhysicianPreferences>) => {
    setPreferencesState(prev => {
      const newPrefs = { ...prev, ...updates };
      // Enforce max length on styleText
      if (newPrefs.styleText.length > MAX_STYLE_TEXT_LENGTH) {
        newPrefs.styleText = newPrefs.styleText.slice(0, MAX_STYLE_TEXT_LENGTH);
      }
      savePreferences(newPrefs);
      return newPrefs;
    });
  }, []);

  const resetPreferences = useCallback(() => {
    const defaults = getDefaultPreferences();
    setPreferencesState(defaults);
    savePreferences(defaults);
  }, []);

  return {
    preferences,
    setPreferences,
    resetPreferences,
  };
};
