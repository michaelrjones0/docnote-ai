import { useState, useEffect, useCallback } from 'react';

export type NoteEditorMode = 'SOAP_4_FIELD' | 'SOAP_3_FIELD';
export type PatientGender = 'male' | 'female' | 'other';
export type LiveDraftMode = 'A' | 'B';

export interface PhysicalExamTemplate {
  id: string;
  name: string;
  content: string;
}

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
  // Templates - legacy single template (kept for backwards compatibility)
  normalPhysicalTemplate: string;
  // Multi-template system
  physicalExamTemplates: PhysicalExamTemplate[];
  defaultPhysicalExamTemplateId: string;
  // Per-encounter template selection (stored in session, not preferences)
  selectedPhysicalExamTemplateId?: string;
  // Live Draft Mode - persists across sessions
  liveDraftMode: LiveDraftMode;
}

const STORAGE_KEY = 'docnoteai_preferences';
const MAX_STYLE_TEXT_LENGTH = 600;
const MAX_TEMPLATE_LENGTH = 2000;
const MAX_TEMPLATES = 10;

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

// Generate a unique ID for templates
const generateTemplateId = (): string => {
  return `tpl_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
};

const getDefaultPhysicalExamTemplates = (): PhysicalExamTemplate[] => [
  {
    id: 'default_general',
    name: 'General / Family Medicine',
    content: DEFAULT_NORMAL_PHYSICAL_TEMPLATE,
  },
];

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
  physicalExamTemplates: getDefaultPhysicalExamTemplates(),
  defaultPhysicalExamTemplateId: 'default_general',
  liveDraftMode: 'A',
});

const loadPreferences = (): PhysicianPreferences => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      
      // Parse physical exam templates array
      let physicalExamTemplates: PhysicalExamTemplate[] = getDefaultPhysicalExamTemplates();
      if (Array.isArray(parsed.physicalExamTemplates) && parsed.physicalExamTemplates.length > 0) {
        physicalExamTemplates = parsed.physicalExamTemplates
          .filter((t: any) => t && typeof t.id === 'string' && typeof t.name === 'string' && typeof t.content === 'string')
          .slice(0, MAX_TEMPLATES)
          .map((t: any) => ({
            id: t.id,
            name: t.name.slice(0, 100),
            content: t.content.slice(0, MAX_TEMPLATE_LENGTH),
          }));
        // Ensure at least one template exists
        if (physicalExamTemplates.length === 0) {
          physicalExamTemplates = getDefaultPhysicalExamTemplates();
        }
      }
      
      // Validate defaultPhysicalExamTemplateId
      let defaultPhysicalExamTemplateId = parsed.defaultPhysicalExamTemplateId;
      if (!physicalExamTemplates.some(t => t.id === defaultPhysicalExamTemplateId)) {
        defaultPhysicalExamTemplateId = physicalExamTemplates[0]?.id || 'default_general';
      }
      
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
        physicalExamTemplates,
        defaultPhysicalExamTemplateId,
        liveDraftMode: ['A', 'B'].includes(parsed.liveDraftMode) ? parsed.liveDraftMode : 'A',
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
      // Enforce max templates count
      if (newPrefs.physicalExamTemplates.length > MAX_TEMPLATES) {
        newPrefs.physicalExamTemplates = newPrefs.physicalExamTemplates.slice(0, MAX_TEMPLATES);
      }
      // Enforce max length on each template
      newPrefs.physicalExamTemplates = newPrefs.physicalExamTemplates.map(t => ({
        ...t,
        name: t.name.slice(0, 100),
        content: t.content.slice(0, MAX_TEMPLATE_LENGTH),
      }));
      savePreferences(newPrefs);
      return newPrefs;
    });
  }, []);

  const addTemplate = useCallback((name: string, content: string) => {
    setPreferencesState(prev => {
      if (prev.physicalExamTemplates.length >= MAX_TEMPLATES) {
        return prev;
      }
      const newTemplate: PhysicalExamTemplate = {
        id: generateTemplateId(),
        name: name.slice(0, 100),
        content: content.slice(0, MAX_TEMPLATE_LENGTH),
      };
      const newPrefs = {
        ...prev,
        physicalExamTemplates: [...prev.physicalExamTemplates, newTemplate],
      };
      savePreferences(newPrefs);
      return newPrefs;
    });
  }, []);

  const updateTemplate = useCallback((id: string, updates: Partial<Omit<PhysicalExamTemplate, 'id'>>) => {
    setPreferencesState(prev => {
      const newPrefs = {
        ...prev,
        physicalExamTemplates: prev.physicalExamTemplates.map(t =>
          t.id === id
            ? {
                ...t,
                ...(updates.name !== undefined ? { name: updates.name.slice(0, 100) } : {}),
                ...(updates.content !== undefined ? { content: updates.content.slice(0, MAX_TEMPLATE_LENGTH) } : {}),
              }
            : t
        ),
      };
      savePreferences(newPrefs);
      return newPrefs;
    });
  }, []);

  const deleteTemplate = useCallback((id: string) => {
    setPreferencesState(prev => {
      // Don't allow deleting the last template
      if (prev.physicalExamTemplates.length <= 1) {
        return prev;
      }
      const newTemplates = prev.physicalExamTemplates.filter(t => t.id !== id);
      let newDefaultId = prev.defaultPhysicalExamTemplateId;
      // If we deleted the default, set a new default
      if (prev.defaultPhysicalExamTemplateId === id) {
        newDefaultId = newTemplates[0]?.id || '';
      }
      const newPrefs = {
        ...prev,
        physicalExamTemplates: newTemplates,
        defaultPhysicalExamTemplateId: newDefaultId,
      };
      savePreferences(newPrefs);
      return newPrefs;
    });
  }, []);

  const setDefaultTemplate = useCallback((id: string) => {
    setPreferencesState(prev => {
      if (!prev.physicalExamTemplates.some(t => t.id === id)) {
        return prev;
      }
      const newPrefs = {
        ...prev,
        defaultPhysicalExamTemplateId: id,
      };
      savePreferences(newPrefs);
      return newPrefs;
    });
  }, []);

  const getActiveTemplate = useCallback((): PhysicalExamTemplate | null => {
    const activeId = preferences.selectedPhysicalExamTemplateId || preferences.defaultPhysicalExamTemplateId;
    return preferences.physicalExamTemplates.find(t => t.id === activeId) || preferences.physicalExamTemplates[0] || null;
  }, [preferences]);

  const resetPreferences = useCallback(() => {
    const defaults = getDefaultPreferences();
    setPreferencesState(defaults);
    savePreferences(defaults);
  }, []);

  return {
    preferences,
    setPreferences,
    resetPreferences,
    // Template management
    addTemplate,
    updateTemplate,
    deleteTemplate,
    setDefaultTemplate,
    getActiveTemplate,
  };
};
