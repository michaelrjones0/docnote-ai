/**
 * useDeepgramDictation - Real-time STT using Deepgram WebSocket
 * 
 * Connects to Deepgram's nova-2-medical model for fast, accurate
 * medical transcription. Uses ephemeral tokens from the deepgram-token
 * edge function for security.
 * 
 * Features:
 * - Ultra-low latency streaming
 * - Medical terminology optimized
 * - Automatic punctuation and formatting
 * - Interim results for live feedback
 */

import { useRef, useCallback, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useDictationContext, DictationStatus } from "@/contexts/DictationContext";

interface DeepgramParams {
  model: string;
  language: string;
  smart_format: boolean;
  punctuate: boolean;
  interim_results: boolean;
  endpointing: number;
  encoding: string;
  sample_rate: number;
  channels: number;
}

interface TokenResponse {
  ok: boolean;
  token?: string;
  params?: DeepgramParams;
  error?: string;
}

export function useDeepgramDictation() {
  const { status, setStatus, insertText } = useDictationContext();
  
  const wsRef = useRef<WebSocket | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const lastFinalRef = useRef<string>("");
  
  // Cleanup function
  const cleanup = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }
    lastFinalRef.current = "";
  }, []);

  // Start dictation
  const start = useCallback(async () => {
    if (status !== "idle") return;
    
    setStatus("connecting");
    
    try {
      // Get ephemeral token from edge function
      const { data, error } = await supabase.functions.invoke<TokenResponse>("deepgram-token");
      
      if (error || !data?.ok || !data.token) {
        console.error("[Deepgram] Token error:", data?.error || error?.message);
        setStatus("idle");
        return;
      }

      const { token, params } = data;
      
      // Build WebSocket URL with params
      const wsUrl = new URL("wss://api.deepgram.com/v1/listen");
      if (params) {
        wsUrl.searchParams.set("model", params.model);
        wsUrl.searchParams.set("language", params.language);
        wsUrl.searchParams.set("smart_format", String(params.smart_format));
        wsUrl.searchParams.set("punctuate", String(params.punctuate));
        wsUrl.searchParams.set("interim_results", String(params.interim_results));
        wsUrl.searchParams.set("endpointing", String(params.endpointing));
        wsUrl.searchParams.set("encoding", params.encoding);
        wsUrl.searchParams.set("sample_rate", String(params.sample_rate));
        wsUrl.searchParams.set("channels", String(params.channels));
      }

      // Connect to Deepgram
      const ws = new WebSocket(wsUrl.toString(), ["token", token]);
      wsRef.current = ws;

      ws.onopen = async () => {
        console.log("[Deepgram] WebSocket connected");
        
        try {
          // Get microphone access
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              sampleRate: 16000,
            },
          });
          mediaStreamRef.current = stream;

          // Set up audio processing
          const audioContext = new AudioContext({ sampleRate: 16000 });
          audioContextRef.current = audioContext;
          
          const source = audioContext.createMediaStreamSource(stream);
          const processor = audioContext.createScriptProcessor(4096, 1, 1);
          processorRef.current = processor;

          processor.onaudioprocess = (e) => {
            if (ws.readyState !== WebSocket.OPEN) return;
            
            const inputData = e.inputBuffer.getChannelData(0);
            // Convert Float32 to Int16
            const int16Data = new Int16Array(inputData.length);
            for (let i = 0; i < inputData.length; i++) {
              const s = Math.max(-1, Math.min(1, inputData[i]));
              int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
            }
            ws.send(int16Data.buffer);
          };

          source.connect(processor);
          processor.connect(audioContext.destination);
          
          setStatus("listening");
        } catch (micError) {
          console.error("[Deepgram] Microphone error");
          cleanup();
          setStatus("idle");
        }
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          if (data.type === "Results" && data.channel?.alternatives?.[0]) {
            const alt = data.channel.alternatives[0];
            const transcript = alt.transcript?.trim();
            
            if (transcript && data.is_final) {
              // Only insert if it's new content (avoid duplicates)
              if (transcript !== lastFinalRef.current) {
                lastFinalRef.current = transcript;
                insertText(transcript);
              }
            }
          }
        } catch (parseError) {
          // Ignore parse errors for non-JSON messages
        }
      };

      ws.onerror = () => {
        console.error("[Deepgram] WebSocket error");
        cleanup();
        setStatus("idle");
      };

      ws.onclose = () => {
        console.log("[Deepgram] WebSocket closed");
        cleanup();
        if (status !== "idle") {
          setStatus("idle");
        }
      };

      // Connection timeout
      setTimeout(() => {
        if (wsRef.current?.readyState === WebSocket.CONNECTING) {
          console.error("[Deepgram] Connection timeout");
          cleanup();
          setStatus("idle");
        }
      }, 5000);

    } catch (err) {
      console.error("[Deepgram] Start error");
      cleanup();
      setStatus("idle");
    }
  }, [status, setStatus, insertText, cleanup]);

  // Stop dictation
  const stop = useCallback(() => {
    cleanup();
    setStatus("idle");
  }, [cleanup, setStatus]);

  // Toggle dictation
  const toggle = useCallback(() => {
    if (status === "idle") {
      start();
    } else {
      stop();
    }
  }, [status, start, stop]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  return {
    status,
    start,
    stop,
    toggle,
    isActive: status !== "idle",
  };
}
