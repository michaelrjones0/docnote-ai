import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireUser, isAuthError } from "../_shared/auth.ts";
import { getCorsHeaders } from "../_shared/env.ts";

/**
 * deepgram-token: Generates a short-lived Deepgram API token for authenticated users.
 * 
 * The browser calls this endpoint, receives a temporary token (30-60s TTL),
 * then connects directly to Deepgram's WebSocket using that token.
 * The main DEEPGRAM_API_KEY never leaves the server.
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

  // Authenticate user
  const authResult = await requireUser(req, corsHeaders);
  if (isAuthError(authResult)) {
    return authResult.error;
  }

  try {
    const DEEPGRAM_API_KEY = Deno.env.get("DEEPGRAM_API_KEY");
    if (!DEEPGRAM_API_KEY) {
      console.error("DEEPGRAM_API_KEY is not configured");
      return new Response(
        JSON.stringify({ error: "Transcription service not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Request a temporary token from Deepgram
    // TTL of 60 seconds - enough for session establishment
    const tokenResponse = await fetch("https://api.deepgram.com/v1/auth/token", {
      method: "POST",
      headers: {
        "Authorization": `Token ${DEEPGRAM_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ttl_seconds: 60,
        scopes: ["usage:listen"],
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error("Deepgram token API error:", tokenResponse.status, errorText);
      return new Response(
        JSON.stringify({ error: "Failed to obtain transcription token" }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const tokenData = await tokenResponse.json();
    
    // Return the temporary token to the client
    // The client will use this to connect directly to Deepgram's WebSocket
    return new Response(
      JSON.stringify({
        token: tokenData.access_token,
        expires_in: tokenData.expires_in || 60,
      }),
      { 
        status: 200, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      }
    );
  } catch (error) {
    console.error("deepgram-token error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
