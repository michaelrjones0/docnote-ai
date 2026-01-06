import { useState, useEffect, useCallback } from 'react';

export interface PhysicianPreferences {
  detailLevel: 'Brief' | 'Standard' | 'Detailed';
  planFormat: 'Bullets' | 'Paragraph';
  firstPerson: boolean;
  patientQuotes: boolean;
}

const STORAGE_KEY = 'docnoteai_preferences';

const getDefaultPreferences = (): PhysicianPreferences => ({
  detailLevel: 'Standard',
  planFormat: 'Bullets',
  firstPerson: false,
  patientQuotes: true,
});

const loadPreferences = (): PhysicianPreferences => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      return {
        detailLevel: ['Brief', 'Standard', 'Detailed'].includes(parsed.detailLevel) 
          ? parsed.detailLevel 
          : 'Standard',
        planFormat: ['Bullets', 'Paragraph'].includes(parsed.planFormat) 
          ? parsed.planFormat 
          : 'Bullets',
        firstPerson: typeof parsed.firstPerson === 'boolean' ? parsed.firstPerson : false,
        patientQuotes: typeof parsed.patientQuotes === 'boolean' ? parsed.patientQuotes : true,
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
