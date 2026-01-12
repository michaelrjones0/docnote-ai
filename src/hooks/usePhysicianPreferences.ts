import { useState, useEffect, useCallback } from 'react';

export type NoteEditorMode = 'SOAP_4_FIELD' | 'SOAP_3_FIELD';
export type PatientGender = 'male' | 'female' | 'other';

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
  patientFirstName: string;
  clinicianDisplayName: string;
  // Required patient info for current encounter
  patientName: string;
  patientGender: PatientGender | '';
  // Templates
  normalPhysicalTemplate: string;
}

const STORAGE_KEY = 'docnoteai_preferences';
const MAX_STYLE_TEXT_LENGTH = 600;
const MAX_TEMPLATE_LENGTH = 1000;

export const DEFAULT_NORMAL_PHYSICAL_TEMPLATE = `General: NAD, well-appearing.
HEENT: Normocephalic, atraumatic. PERRL, EOMI. TMs clear. Oropharynx clear.
Neck: Supple, no lymphadenopathy.
CV: RRR, no murmurs, rubs, or gallops.
Lungs: CTA bilaterally, no wheezes, rales, or rhonchi.
Abdomen: Soft, non-tender, non-distended, normoactive bowel sounds.
Extremities: No edema, cyanosis, or clubbing. Full ROM.
Neuro: Alert and oriented x3. CN II-XII intact. Normal gait.`;

// Helper to get pronouns based on gender
export const getPronounSet = (gender: PatientGender | ''): { subject: string; object: string; possessive: string } => {
  switch (gender) {
    case 'male':
      return { subject: 'he', object: 'him', possessive: 'his' };
    case 'female':
      return { subject: 'she', object: 'her', possessive: 'her' };
    case 'other':
    default:
      return { subject: 'they', object: 'them', possessive: 'their' };
  }
};

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
  patientFirstName: '',
  clinicianDisplayName: '',
  patientName: '',
  patientGender: '',
  normalPhysicalTemplate: DEFAULT_NORMAL_PHYSICAL_TEMPLATE,
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
        patientFirstName: typeof parsed.patientFirstName === 'string' ? parsed.patientFirstName : '',
        clinicianDisplayName: typeof parsed.clinicianDisplayName === 'string' ? parsed.clinicianDisplayName : '',
        patientName: typeof parsed.patientName === 'string' ? parsed.patientName : '',
        patientGender: ['male', 'female', 'other'].includes(parsed.patientGender) ? parsed.patientGender : '',
        normalPhysicalTemplate: typeof parsed.normalPhysicalTemplate === 'string' 
          ? parsed.normalPhysicalTemplate.slice(0, MAX_TEMPLATE_LENGTH) 
          : DEFAULT_NORMAL_PHYSICAL_TEMPLATE,
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
      // Enforce max length on normalPhysicalTemplate
      if (newPrefs.normalPhysicalTemplate.length > MAX_TEMPLATE_LENGTH) {
        newPrefs.normalPhysicalTemplate = newPrefs.normalPhysicalTemplate.slice(0, MAX_TEMPLATE_LENGTH);
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
