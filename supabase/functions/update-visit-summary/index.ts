import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { getCorsHeaders } from "../_shared/env.ts";
import { requireUser, isAuthError } from "../_shared/auth.ts";

// Timeout for OpenAI call (30 seconds)
const AI_TIMEOUT_MS = 30000;

// Dev mode check - include detailed errors in response when not in production
const isDevMode = () => {
  const env = Deno.env.get('ENV') || Deno.env.get('DENO_ENV') || '';
  const devFlag = Deno.env.get('DEV_MODE');
  return devFlag === 'true' || (env !== 'production' && env !== 'prod');
};

// Helper to build error response with dev-only details
const buildErrorResponse = (
  genericMessage: string,
  status: number,
  corsHeaders: Record<string, string>,
  devDetails?: { message?: string; stack?: string; details?: string }
) => {
  const isDev = isDevMode();
  const responseBody: Record<string, unknown> = { error: genericMessage };
  
  if (isDev && devDetails) {
    responseBody.dev = {
      message: devDetails.message,
      stack: devDetails.stack?.slice(0, 500),
      details: devDetails.details?.slice(0, 1000),
    };
  }
  
  return new Response(
    JSON.stringify(responseBody),
    { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
};

serve(async (req) => {
  const origin = req.headers.get('Origin');
  const { headers: corsHeaders, isAllowed } = getCorsHeaders(origin);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Block disallowed origins
  if (!isAllowed) {
    return new Response(
      JSON.stringify({ error: 'Origin not allowed' }),
      { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // Verify JWT using shared auth helper
  const authResult = await requireUser(req, corsHeaders);
  if (isAuthError(authResult)) {
    return authResult.error;
  }

  try {
    const body = await req.json();
    const { transcriptDelta, runningSummary, preferences } = body;
    
    // SECURITY: Log only operational metadata, never PHI content
    console.log('[update-visit-summary] Request received');

    // Validate transcriptDelta
    if (!transcriptDelta || typeof transcriptDelta !== 'string' || !transcriptDelta.trim()) {
      console.error('[update-visit-summary] Invalid transcriptDelta');
      return new Response(
        JSON.stringify({ error: 'transcriptDelta is required and must be a non-empty string' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Use OpenAI API directly
    const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY');
    if (!OPENAI_API_KEY) {
      console.error('[update-visit-summary] OPENAI_API_KEY not configured');
      return buildErrorResponse('AI API key not configured', 500, corsHeaders);
    }

    // Build the voice instruction
    const voiceInstruction = preferences?.firstPerson === true
      ? 'Use first-person clinician voice ("I noted...", "Patient reports to me...").'
      : 'Use neutral third-person clinical voice ("Patient reports...", "Exam reveals...").';

    const systemPrompt = `You are a clinical documentation assistant creating a RUNNING SUMMARY of a visit in progress.

STRICT RULES:
1. TRANSCRIPT-ONLY: Do not add any clinical findings, vitals, diagnoses, or facts not explicitly stated in the transcript.
2. Keep the summary SHORT: maximum ~1200 characters total.
3. ${voiceInstruction}
4. Do NOT include Objective findings unless the clinician explicitly states exam findings, vitals, or test results.

FORMAT (use exactly this structure):
Problems:
- <bullet list of problems mentioned>

Key details:
- <relevant history, symptoms, medications, etc.>

Plan mentioned:
- <any treatment plans, orders, referrals discussed>

If a section has no relevant content from the transcript, omit that section entirely.

You will receive:
- Previous summary (if any): Incorporate and update it with new information
- New transcript chunk: The latest portion of the conversation

Output ONLY the updated running summary text. No JSON, no markdown headers, just the formatted summary.`;

    const userMessage = runningSummary
      ? `Previous summary:\n${runningSummary}\n\nNew transcript chunk:\n${transcriptDelta}`
      : `New transcript chunk:\n${transcriptDelta}`;

    // SECURITY: Do not log transcript content or length

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

    let aiResponse: Response;
    try {
      aiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage }
          ],
          max_tokens: 1000,
          temperature: 0.3,
        }),
        signal: controller.signal,
      });
    } catch (fetchError) {
      clearTimeout(timeoutId);
      if (fetchError instanceof Error && fetchError.name === 'AbortError') {
        console.error('[update-visit-summary] OpenAI timeout');
        return buildErrorResponse('AI request timed out, please try again', 504, corsHeaders);
      }
      // SECURITY: Do not log error details
      console.error('[update-visit-summary] Fetch error');
      throw fetchError;
    } finally {
      clearTimeout(timeoutId);
    }

    if (!aiResponse.ok) {
      // SECURITY: Log only status code, not error body which may contain PHI
      console.error('[update-visit-summary] OpenAI API error:', aiResponse.status);
      
      if (aiResponse.status === 429) {
        return buildErrorResponse('Rate limit exceeded, please try again later', 429, corsHeaders);
      }
      if (aiResponse.status === 401) {
        return buildErrorResponse('AI authentication failed', 500, corsHeaders);
      }
      if (aiResponse.status === 402 || aiResponse.status === 403) {
        return buildErrorResponse('AI quota exceeded or access denied', 402, corsHeaders);
      }
      return buildErrorResponse('Failed to generate summary', 500, corsHeaders);
    }

    const aiData = await aiResponse.json();
    const newSummary = aiData.choices?.[0]?.message?.content?.trim() || '';

    if (!newSummary) {
      console.error('[update-visit-summary] Empty summary from OpenAI');
      return buildErrorResponse('AI returned empty summary', 500, corsHeaders);
    }

    // Enforce max length
    const truncatedSummary = newSummary.length > 1200 
      ? newSummary.slice(0, 1200) + '...'
      : newSummary;

    const updatedAt = new Date().toISOString();
    // SECURITY: Do not log summary content or length

    return new Response(
      JSON.stringify({ 
        runningSummary: truncatedSummary,
        summary: truncatedSummary, // alias for client compatibility
        updatedAt
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    // SECURITY: Log only that error occurred, not details
    console.error('[update-visit-summary] Unhandled error');
    
    const origin = req.headers.get('Origin');
    const { headers: catchCorsHeaders } = getCorsHeaders(origin);
    return buildErrorResponse('An unexpected error occurred', 500, catchCorsHeaders);
  }
});
