import { useState, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { safeErrorLog, debugLogPHI } from '@/lib/debug';

interface TranscriptSegment {
  id: string;
  content: string;
  speaker?: string;
  timestamp: Date;
  chunkIndex: number;
  startMs?: number;
  endMs?: number;
}

export function useTranscription() {
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([]);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Queue management for sequential processing
  const queueRef = useRef<Promise<string>>(Promise.resolve(''));
  const chunkIndexRef = useRef(0);

  const transcribeAudio = useCallback(async (audioBlob: Blob): Promise<string> => {
    // Get the next chunk index
    const currentChunkIndex = chunkIndexRef.current++;
    const mimeType = audioBlob.type || 'audio/webm';
    
    // Chain this transcription to the queue to ensure sequential processing
    const transcriptionPromise = queueRef.current.then(async () => {
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

        const { data, error: fnError } = await supabase.functions.invoke('transcribe-audio-live', {
          body: { 
            audio: base64Audio,
            chunkIndex: currentChunkIndex,
            mimeType
          }
        });

        if (fnError) {
          throw fnError;
        }

        // Check for format errors
        if (data?.error && data?.supportedFormats) {
          throw new Error(data.error);
        }

        const text = data?.text || '';
        const segments = data?.segments as Array<{
          content: string;
          speaker: string;
          startMs: number;
          endMs: number;
        }> | undefined;
        
        // Debug log PHI only in debug mode
        debugLogPHI('[Transcription] Received text:', text, 100);
        
        // Prefer segments if available, otherwise use full text
        if (segments && segments.length > 0) {
          const newSegments: TranscriptSegment[] = segments.map((seg, idx) => ({
            id: crypto.randomUUID(),
            content: seg.content,
            speaker: seg.speaker,
            timestamp: new Date(),
            chunkIndex: currentChunkIndex,
            startMs: seg.startMs,
            endMs: seg.endMs,
          }));
          
          setTranscript(prev => {
            const updated = [...prev, ...newSegments];
            // Sort by chunkIndex, then by startMs within chunk
            return updated.sort((a, b) => {
              if (a.chunkIndex !== b.chunkIndex) {
                return a.chunkIndex - b.chunkIndex;
              }
              return (a.startMs ?? 0) - (b.startMs ?? 0);
            });
          });
        } else if (text) {
          const segment: TranscriptSegment = {
            id: crypto.randomUUID(),
            content: text,
            timestamp: new Date(),
            chunkIndex: currentChunkIndex,
          };
          setTranscript(prev => {
            const updated = [...prev, segment];
            return updated.sort((a, b) => a.chunkIndex - b.chunkIndex);
          });
        }

        return text;

      } catch (err) {
        safeErrorLog('[Transcription] Error:', err);
        const errorMessage = err instanceof Error ? err.message : 'Transcription failed';
        setError(errorMessage);
        throw err;
      } finally {
        setIsTranscribing(false);
      }
    });

    // Update the queue reference
    queueRef.current = transcriptionPromise.catch(() => '');
    
    return transcriptionPromise;
  }, []);

  const addManualTranscript = useCallback((content: string, speaker?: string) => {
    const currentChunkIndex = chunkIndexRef.current++;
    const segment: TranscriptSegment = {
      id: crypto.randomUUID(),
      content,
      speaker,
      timestamp: new Date(),
      chunkIndex: currentChunkIndex,
    };
    setTranscript(prev => {
      const updated = [...prev, segment];
      return updated.sort((a, b) => a.chunkIndex - b.chunkIndex);
    });
  }, []);

  const clearTranscript = useCallback(() => {
    setTranscript([]);
    setError(null);
    chunkIndexRef.current = 0;
    queueRef.current = Promise.resolve('');
  }, []);

  const getFullTranscript = useCallback(() => {
    // Sort by chunkIndex before joining
    const sorted = [...transcript].sort((a, b) => a.chunkIndex - b.chunkIndex);
    return sorted.map(s => {
      if (s.speaker) {
        return `[${s.speaker}]: ${s.content}`;
      }
      return s.content;
    }).join('\n\n');
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
