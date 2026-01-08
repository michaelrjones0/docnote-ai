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

  // Return 200 with disabled flag - prevents 5xx errors in logs
  // Frontend checks ok:false and uses batch fallback
  return new Response(
    JSON.stringify({
      ok: false,
      error: "Deepgram relay not configured",
      disabled: true,
    }),
    { 
      status: 200, // OK status - no errors in logs
      headers: { ...corsHeaders, "Content-Type": "application/json" } 
    }
  );
});