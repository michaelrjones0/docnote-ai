/**
 * Deepgram Token Edge Function
 * 
 * Generates short-lived ephemeral tokens for secure client-side WebSocket connections.
 * Uses the nova-2-medical model optimized for medical terminology.
 * 
 * SECURITY: 
 * - Requires JWT authentication
 * - Never exposes DEEPGRAM_API_KEY to client
 * - PHI-safe logging (no tokens or content logged)
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { getCorsHeaders, getRequiredEnv } from "../_shared/env.ts";
import { requireUser, isAuthError } from "../_shared/auth.ts";
import { jsonResponse, errorResponse } from "../_shared/response.ts";

serve(async (req) => {
  const origin = req.headers.get("origin");
  const { headers: corsHeaders, isAllowed } = getCorsHeaders(origin);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Block disallowed origins
  if (!isAllowed) {
    console.error("[deepgram-token] Origin not allowed");
    return errorResponse("Forbidden", 403, corsHeaders);
  }

  // Require authentication
  const authResult = await requireUser(req, corsHeaders);
  if (isAuthError(authResult)) {
    return authResult.error;
  }

  try {
    const apiKey = getRequiredEnv("DEEPGRAM_API_KEY");

    // Request a temporary API key from Deepgram
    // These keys are short-lived and safe for client-side use
    const response = await fetch("https://api.deepgram.com/v1/projects", {
      method: "GET",
      headers: {
        "Authorization": `Token ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      console.error("[deepgram-token] Failed to fetch projects");
      return jsonResponse({ ok: false, error: "Deepgram API unavailable" }, corsHeaders);
    }

    const projectsData = await response.json();
    const projectId = projectsData.projects?.[0]?.project_id;

    if (!projectId) {
      console.error("[deepgram-token] No project found");
      return jsonResponse({ ok: false, error: "Deepgram project not configured" }, corsHeaders);
    }

    // Create a temporary API key valid for 60 seconds
    const keyResponse = await fetch(
      `https://api.deepgram.com/v1/projects/${projectId}/keys`,
      {
        method: "POST",
        headers: {
          "Authorization": `Token ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          comment: "Ephemeral dictation key",
          scopes: ["usage:write"],
          // Short TTL for security - client should reconnect if expired
          time_to_live_in_seconds: 60,
        }),
      }
    );

    if (!keyResponse.ok) {
      console.error("[deepgram-token] Failed to create ephemeral key");
      return jsonResponse({ ok: false, error: "Failed to generate token" }, corsHeaders);
    }

    const keyData = await keyResponse.json();

    console.log("[deepgram-token] Token generated successfully");

    return jsonResponse({
      ok: true,
      token: keyData.key,
      expiresIn: 60,
      // Client connection params for nova-2-medical
      params: {
        model: "nova-2-medical",
        language: "en-US",
        smart_format: true,
        punctuate: true,
        interim_results: true,
        endpointing: 300,
        encoding: "linear16",
        sample_rate: 16000,
        channels: 1,
      },
    }, corsHeaders);

  } catch (error) {
    console.error("[deepgram-token] Error:", error instanceof Error ? error.message : "Unknown error");
    return errorResponse("Internal server error", 500, corsHeaders);
  }
});
