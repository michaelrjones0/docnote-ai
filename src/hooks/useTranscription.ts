import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

interface TranscriptSegment {
  id: string;
  content: string;
  speaker?: string;
  timestamp: Date;
}

export function useTranscription() {
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([]);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const transcribeAudio = useCallback(async (audioBlob: Blob): Promise<string> => {
    setIsTranscribing(true);
    setError(null);

    try {
      // Convert blob to base64
      const reader = new FileReader();
      const base64Promise = new Promise<string>((resolve, reject) => {
        reader.onloadend = () => {
          const base64 = (reader.result as string).split(',')[1];
          resolve(base64);
        };
        reader.onerror = reject;
      });
      reader.readAsDataURL(audioBlob);
      const base64Audio = await base64Promise;

      const { data, error: fnError } = await supabase.functions.invoke('transcribe-audio', {
        body: { audio: base64Audio }
      });

      if (fnError) {
        throw fnError;
      }

      const text = data?.text || '';
      
      if (text) {
        const segment: TranscriptSegment = {
          id: crypto.randomUUID(),
          content: text,
          timestamp: new Date(),
        };
        setTranscript(prev => [...prev, segment]);
      }

      return text;

    } catch (err) {
      console.error('Transcription error:', err);
      const errorMessage = err instanceof Error ? err.message : 'Transcription failed';
      setError(errorMessage);
      throw err;
    } finally {
      setIsTranscribing(false);
    }
  }, []);

  const addManualTranscript = useCallback((content: string, speaker?: string) => {
    const segment: TranscriptSegment = {
      id: crypto.randomUUID(),
      content,
      speaker,
      timestamp: new Date(),
    };
    setTranscript(prev => [...prev, segment]);
  }, []);

  const clearTranscript = useCallback(() => {
    setTranscript([]);
    setError(null);
  }, []);

  const getFullTranscript = useCallback(() => {
    return transcript.map(s => s.content).join('\n\n');
  }, [transcript]);

  return {
    transcript,
    isTranscribing,
    error,
    transcribeAudio,
    addManualTranscript,
    clearTranscript,
    getFullTranscript,
  };
}