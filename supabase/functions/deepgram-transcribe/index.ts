// Supabase Edge Function: deepgram-transcribe
// Purpose: accept base64 audio from the client, call Deepgram REST /v1/listen using secret DEEPGRAM_API_KEY,
// and return the transcript. Keeps Deepgram key off the client.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

function corsHeaders(origin: string | null) {
  // Permissive for Lovable previews; tighten later if needed.
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function json(status: number, body: unknown, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json",
    },
  });
}

function b64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

serve(async (req) => {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") return json(200, { ok: true }, origin);
  if (req.method !== "POST") return json(405, { error: "Use POST" }, origin);

  const DEEPGRAM_API_KEY = Deno.env.get("DEEPGRAM_API_KEY");
  if (!DEEPGRAM_API_KEY) {
    return json(500, { error: "Missing DEEPGRAM_API_KEY on server" }, origin);
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body" }, origin);
  }

  const audioBase64 = payload?.audioBase64;
  const mimeType = payload?.mimeType;

  if (!audioBase64 || typeof audioBase64 !== "string") {
    return json(400, { error: "audioBase64 (string) is required" }, origin);
  }
  if (!mimeType || typeof mimeType !== "string") {
    return json(400, { error: "mimeType (string) is required, e.g. audio/webm or audio/wav" }, origin);
  }

  // Decode audio bytes from base64
  let audioBytes: Uint8Array;
  try {
    audioBytes = b64ToUint8Array(audioBase64);
  } catch {
    return json(400, { error: "Base64 decode failed" }, origin);
  }

  // Convert Uint8Array -> ArrayBuffer slice (fixes TS typing errors in Edge runtime)
  const audioBuf = audioBytes.buffer.slice(audioBytes.byteOffset, audioBytes.byteOffset + audioBytes.byteLength);

  // Deepgram REST (pre-recorded) endpoint.
  // For container formats like WebM/WAV, omit encoding/sample_rate and just set Content-Type correctly.
  const url =
    "https://api.deepgram.com/v1/listen" +
    "?model=nova-2-medical" +
    "&language=en-US" +
    "&punctuate=true" +
    "&smart_format=true" +
    "&dictation=true";

  let dgRes: Response;
  try {
    dgRes = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Token ${DEEPGRAM_API_KEY}`,
        "Content-Type": mimeType,
      },
      body: audioBuf,
    });
  } catch {
    return json(502, { error: "Failed to reach Deepgram" }, origin);
  }

  const dgText = await dgRes.text();

  if (!dgRes.ok) {
    // PHI-safe: no audio echoed; DG error text is usually safe (no transcript), but keep it truncated.
    return json(dgRes.status, { error: "Deepgram error", detail: dgText.slice(0, 2000) }, origin);
  }

  // Parse Deepgram response and extract transcript
  let dgJson: any;
  try {
    dgJson = JSON.parse(dgText);
  } catch {
    return json(500, { error: "Deepgram returned non-JSON", detail: dgText.slice(0, 500) }, origin);
  }

  const transcript = dgJson?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";

  return json(200, { ok: true, transcript }, origin);
});
