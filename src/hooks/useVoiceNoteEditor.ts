import { useState, useRef, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { safeErrorLog } from '@/lib/debug';

// Check if error is auth-related (401, expired token, etc.)
const isAuthError = (error: unknown): boolean => {
  const msg = error instanceof Error ? error.message : String(error);
  return /unauthorized|401|invalid.*token|expired|not authenticated/i.test(msg);
};

export function useVoiceNoteEditor() {
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [voiceMode, setVoiceMode] = useState<'dictate' | 'instruct'>('dictate');
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const { toast } = useToast();

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      
      chunksRef.current = [];
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start();
      setIsRecording(true);
    } catch (error) {
      console.error('Error starting recording:', error);
      toast({ 
        title: 'Microphone error', 
        description: 'Could not access microphone. Please check permissions.', 
        variant: 'destructive' 
      });
    }
  }, [toast]);

  const stopRecording = useCallback(async (): Promise<Blob | null> => {
    return new Promise((resolve) => {
      if (!mediaRecorderRef.current || mediaRecorderRef.current.state === 'inactive') {
        setIsRecording(false);
        resolve(null);
        return;
      }

      mediaRecorderRef.current.onstop = () => {
        const audioBlob = new Blob(chunksRef.current, { type: 'audio/webm' });
        mediaRecorderRef.current?.stream.getTracks().forEach(track => track.stop());
        setIsRecording(false);
        resolve(audioBlob);
      };

      mediaRecorderRef.current.stop();
    });
  }, []);

  const transcribeAudio = useCallback(async (audioBlob: Blob): Promise<string | null> => {
    setIsProcessing(true);
    try {
      const reader = new FileReader();
      const base64Promise = new Promise<string>((resolve) => {
        reader.onloadend = () => {
          const base64 = (reader.result as string).split(',')[1];
          resolve(base64);
        };
      });
      reader.readAsDataURL(audioBlob);
      const base64Audio = await base64Promise;

      const { data, error } = await supabase.functions.invoke('transcribe-audio-live', {
        body: { audio: base64Audio }
      });

      if (error) throw error;
      return data?.text || null;
    } catch (error) {
      safeErrorLog('[VoiceNoteEditor] Transcription error', error);
      if (isAuthError(error)) {
        toast({ title: 'Session expired', description: 'Please sign in again.', variant: 'destructive' });
      } else {
        toast({ title: 'Transcription failed', variant: 'destructive' });
      }
      return null;
    } finally {
      setIsProcessing(false);
    }
  }, [toast]);

  const applyVoiceInstruction = useCallback(async (
    currentNote: string, 
    instruction: string
  ): Promise<string | null> => {
    setIsProcessing(true);
    try {
      const { data, error } = await supabase.functions.invoke('edit-note-voice', {
        body: { currentNote, instruction }
      });

      if (error) throw error;
      
      toast({ title: 'Instruction applied' });
      return data?.editedNote || null;
    } catch (error) {
      safeErrorLog('[VoiceNoteEditor] Voice instruction error', error);
      if (isAuthError(error)) {
        toast({ title: 'Session expired', description: 'Please sign in again.', variant: 'destructive' });
      } else {
        toast({ title: 'Failed to apply instruction', variant: 'destructive' });
      }
      return null;
    } finally {
      setIsProcessing(false);
    }
  }, [toast]);

  return {
    isRecording,
    isProcessing,
    voiceMode,
    setVoiceMode,
    startRecording,
    stopRecording,
    transcribeAudio,
    applyVoiceInstruction,
  };
}
