import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Timeout for AI gateway call (30 seconds)
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
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    
    // Log received request keys for debugging
    console.log('[update-visit-summary] Request body keys:', Object.keys(body));
    
    const { transcriptDelta, runningSummary, preferences } = body;
    
    console.log('[update-visit-summary] Received:', {
      transcriptDeltaLength: transcriptDelta?.length ?? 0,
      runningSummaryLength: runningSummary?.length ?? 0,
      hasPreferences: !!preferences,
    });

    // Validate transcriptDelta
    if (!transcriptDelta || typeof transcriptDelta !== 'string' || !transcriptDelta.trim()) {
      console.error('[update-visit-summary] Invalid transcriptDelta:', typeof transcriptDelta, transcriptDelta?.length);
      return new Response(
        JSON.stringify({ 
          error: 'transcriptDelta is required and must be a non-empty string',
          received: { type: typeof transcriptDelta, length: transcriptDelta?.length }
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Use Lovable AI Gateway (LOVABLE_API_KEY is auto-provisioned)
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) {
      console.error('[update-visit-summary] LOVABLE_API_KEY not found in environment');
      return new Response(
        JSON.stringify({ error: 'AI API key not configured (LOVABLE_API_KEY missing)' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    console.log('[update-visit-summary] LOVABLE_API_KEY present, length:', LOVABLE_API_KEY.length);

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

    console.log('[update-visit-summary] Calling Lovable AI Gateway, transcript delta length:', transcriptDelta.length);

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

    let aiResponse: Response;
    try {
      aiResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${LOVABLE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'google/gemini-2.5-flash',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage }
          ],
        }),
        signal: controller.signal,
      });
    } catch (fetchError) {
      clearTimeout(timeoutId);
      if (fetchError instanceof Error && fetchError.name === 'AbortError') {
        console.error('[update-visit-summary] AI Gateway timeout after', AI_TIMEOUT_MS, 'ms');
        return new Response(
          JSON.stringify({ error: 'AI request timed out, please try again' }),
          { status: 504, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      throw fetchError;
    } finally {
      clearTimeout(timeoutId);
    }

    console.log('[update-visit-summary] AI Gateway response status:', aiResponse.status);

    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();
      // Always log full error server-side
      console.error('[update-visit-summary] AI Gateway error:', {
        status: aiResponse.status,
        statusText: aiResponse.statusText,
        errorBody: errorText,
      });
      
      // Handle rate limiting
      if (aiResponse.status === 429) {
        return buildErrorResponse(
          'Rate limit exceeded, please try again later',
          429,
          { details: errorText }
        );
      }
      
      // Handle payment required
      if (aiResponse.status === 402) {
        return buildErrorResponse(
          'AI credits exhausted, please add funds',
          402,
          { details: errorText }
        );
      }
      
      return buildErrorResponse(
        'Failed to generate summary',
        500,
        { message: `AI Gateway error: ${aiResponse.status}`, details: errorText }
      );
    }

    const aiData = await aiResponse.json();
    console.log('[update-visit-summary] AI response received, choices:', aiData.choices?.length);
    
    const newSummary = aiData.choices?.[0]?.message?.content?.trim() || '';

    if (!newSummary) {
      const aiDataStr = JSON.stringify(aiData).slice(0, 1000);
      console.error('[update-visit-summary] Empty summary from AI. Full response:', aiDataStr);
      return buildErrorResponse(
        'AI returned empty summary',
        500,
        { message: 'No content in AI response', details: aiDataStr }
      );
    }

    // Enforce max length
    const truncatedSummary = newSummary.length > 1200 
      ? newSummary.slice(0, 1200) + '...'
      : newSummary;

    const updatedAt = new Date().toISOString();
    console.log('[update-visit-summary] Success! Summary length:', truncatedSummary.length);

    return new Response(
      JSON.stringify({ 
        runningSummary: truncatedSummary,
        summary: truncatedSummary, // alias for client compatibility
        updatedAt
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    // Always log full error server-side
    console.error('[update-visit-summary] Unhandled error:', {
      message: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      error,
    });
    
    return buildErrorResponse(
      'An unexpected error occurred',
      500,
      {
        message: error instanceof Error ? error.message : 'Unknown server error',
        stack: error instanceof Error ? error.stack : undefined,
      }
    );
  }
});
