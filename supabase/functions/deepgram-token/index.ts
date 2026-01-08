import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { getCorsHeaders } from "../_shared/env.ts";

/**
 * deepgram-token: TEMPORARILY DISABLED
 * 
 * Deepgram's token minting endpoint is returning 405.
 * Until we implement a WebSocket relay, this returns a clear error
 * so the frontend can cleanly fallback to batch dictation.
 * 
 * TODO: Replace with WebSocket relay URL once deployed (Render/Fly/Cloud Run)
 */

serve(async (req) => {
  const origin = req.headers.get("origin");
  const { headers: corsHeaders, isAllowed } = getCorsHeaders(origin);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Reject disallowed origins
  if (!isAllowed) {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Return clear error - Deepgram token endpoint is disabled
  // Frontend should fall back to batch dictation
  return new Response(
    JSON.stringify({
      ok: false,
      error: "Deepgram token endpoint unsupported; using relay",
      fallback: "batch",
    }),
    { 
      status: 503, // Service Unavailable - clear signal to fallback
      headers: { ...corsHeaders, "Content-Type": "application/json" } 
    }
  );
});