import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { transcriptDelta, runningSummary, preferences } = await req.json();

    if (!transcriptDelta || typeof transcriptDelta !== 'string' || !transcriptDelta.trim()) {
      return new Response(
        JSON.stringify({ error: 'transcriptDelta is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY');
    if (!OPENAI_API_KEY) {
      return new Response(
        JSON.stringify({ error: 'OpenAI API key not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
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

    console.log('[update-visit-summary] Processing transcript delta, length:', transcriptDelta.length);

    const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
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
        temperature: 0.3,
        max_tokens: 600,
      }),
    });

    if (!openaiResponse.ok) {
      const errorText = await openaiResponse.text();
      console.error('[update-visit-summary] OpenAI error:', errorText);
      return new Response(
        JSON.stringify({ error: 'Failed to generate summary' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const openaiData = await openaiResponse.json();
    const newSummary = openaiData.choices?.[0]?.message?.content?.trim() || '';

    // Enforce max length
    const truncatedSummary = newSummary.length > 1200 
      ? newSummary.slice(0, 1200) + '...'
      : newSummary;

    console.log('[update-visit-summary] Generated summary, length:', truncatedSummary.length);

    return new Response(
      JSON.stringify({ runningSummary: truncatedSummary }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[update-visit-summary] Error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
