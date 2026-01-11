/**
 * public-config - Returns non-sensitive runtime configuration
 * 
 * NO AUTH REQUIRED - This endpoint returns only public configuration values.
 * PHI-Safe: Returns only URLs, logs nothing sensitive.
 */

import { getCorsHeaders } from "../_shared/env.ts";

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  const { headers: corsHeaders } = getCorsHeaders(origin);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Only allow GET
  if (req.method !== "GET") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Get config from environment
  const deepgramRelayUrl = Deno.env.get("DEEPGRAM_RELAY_URL") || "";

  // Return config (PHI-safe - only URLs, no sensitive data)
  return new Response(
    JSON.stringify({
      deepgramRelayUrl,
    }),
    { 
      status: 200, 
      headers: { 
        ...corsHeaders, 
        "Content-Type": "application/json",
        // Cache for 5 minutes - config rarely changes
        "Cache-Control": "public, max-age=300",
      } 
    }
  );
});
