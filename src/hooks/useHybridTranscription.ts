import { useState, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';

interface TranscriptSegment {
  id: string;
  content: string;
  speaker?: string;
  timestamp: Date;
  isLive: boolean;
}

interface BatchTranscriptResult {
  text: string;
  speakers: any[];
  items: any[];
}

export function useHybridTranscription() {
  const [liveTranscript, setLiveTranscript] = useState<TranscriptSegment[]>([]);
  const [batchTranscript, setBatchTranscript] = useState<string>('');
  const [isLiveTranscribing, setIsLiveTranscribing] = useState(false);
  const [isBatchProcessing, setIsBatchProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const fullAudioChunksRef = useRef<Blob[]>([]);

  // Process a live audio chunk for real-time transcription
  const transcribeLiveChunk = useCallback(async (audioBlob: Blob): Promise<string> => {
    setIsLiveTranscribing(true);
    setError(null);

    try {
      // Store chunk for later batch processing
      fullAudioChunksRef.current.push(audioBlob);

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

      const { data, error: fnError } = await supabase.functions.invoke('transcribe-audio-live', {
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
          isLive: true,
        };
        setLiveTranscript(prev => [...prev, segment]);
      }

      return text;

    } catch (err) {
      console.error('Live transcription error:', err);
      const errorMessage = err instanceof Error ? err.message : 'Live transcription failed';
      setError(errorMessage);
      // Don't throw - live transcription errors shouldn't block the encounter
      return '';
    } finally {
      setIsLiveTranscribing(false);
    }
  }, []);

  // Process the full recording with batch transcription for accuracy
  const processBatchTranscription = useCallback(async (
    fullAudioBlob: Blob,
    encounterId?: string
  ): Promise<BatchTranscriptResult> => {
    setIsBatchProcessing(true);
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
      reader.readAsDataURL(fullAudioBlob);
      const base64Audio = await base64Promise;

      console.log('Starting batch transcription for encounter:', encounterId);

      const { data, error: fnError } = await supabase.functions.invoke('transcribe-audio-batch', {
        body: { 
          audio: base64Audio,
          encounterId: encounterId
        }
      });

      if (fnError) {
        throw fnError;
      }

      const result: BatchTranscriptResult = {
        text: data?.text || '',
        speakers: data?.speakers || [],
        items: data?.items || []
      };

      setBatchTranscript(result.text);
      console.log('Batch transcription completed');

      return result;

    } catch (err) {
      console.error('Batch transcription error:', err);
      const errorMessage = err instanceof Error ? err.message : 'Batch transcription failed';
      setError(errorMessage);
      throw err;
    } finally {
      setIsBatchProcessing(false);
    }
  }, []);

  // Combine stored chunks into a single blob for batch processing
  const getFullAudioBlob = useCallback((): Blob | null => {
    if (fullAudioChunksRef.current.length === 0) {
      return null;
    }
    return new Blob(fullAudioChunksRef.current, { type: 'audio/webm' });
  }, []);

  // Get the current transcript (prefer batch if available, else live)
  const getCurrentTranscript = useCallback((): string => {
    if (batchTranscript) {
      return batchTranscript;
    }
    return liveTranscript.map(s => s.content).join('\n\n');
  }, [batchTranscript, liveTranscript]);

  // Get the live transcript as a formatted string
  const getLiveTranscriptText = useCallback((): string => {
    return liveTranscript.map(s => s.content).join('\n\n');
  }, [liveTranscript]);

  const clearTranscripts = useCallback(() => {
    setLiveTranscript([]);
    setBatchTranscript('');
    setError(null);
    fullAudioChunksRef.current = [];
  }, []);

  const addManualTranscript = useCallback((content: string, speaker?: string) => {
    const segment: TranscriptSegment = {
      id: crypto.randomUUID(),
      content,
      speaker,
      timestamp: new Date(),
      isLive: false,
    };
    setLiveTranscript(prev => [...prev, segment]);
  }, []);

  return {
    liveTranscript,
    batchTranscript,
    isLiveTranscribing,
    isBatchProcessing,
    error,
    transcribeLiveChunk,
    processBatchTranscription,
    getFullAudioBlob,
    getCurrentTranscript,
    getLiveTranscriptText,
    clearTranscripts,
    addManualTranscript,
  };
}
