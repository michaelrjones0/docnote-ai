import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { 
      patientNotes, 
      currentChiefComplaint, 
      chronicConditions 
    } = await req.json();

    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) {
      throw new Error('LOVABLE_API_KEY is not configured');
    }

    console.log('Searching patient context...');
    console.log('Chief complaint:', currentChiefComplaint);
    console.log('Chronic conditions:', chronicConditions?.length || 0);

    // Build the context for AI analysis
    const notesContext = patientNotes?.map((note: any, index: number) => `
Note ${index + 1} (${note.date}, ${note.type}):
Chief Complaint: ${note.chiefComplaint || 'N/A'}
Content: ${note.content}
`).join('\n---\n') || 'No previous notes available.';

    const chronicContext = chronicConditions?.map((c: any) => 
      `${c.condition_name}${c.icd_code ? ` (${c.icd_code})` : ''}`
    ).join(', ') || 'None documented';

    const systemPrompt = `You are a medical AI assistant helping clinicians review patient history. Your task is to:

1. Analyze previous patient notes and identify information relevant to the current chief complaint
2. Find any related conditions, previous treatments, or assessments that should inform today's visit
3. Flag any pending follow-ups or action items from previous visits
4. Summarize relevant chronic condition management history

Be concise but thorough. Focus on clinically actionable information.`;

    const userPrompt = `Current Chief Complaint: ${currentChiefComplaint || 'Not specified'}

Chronic Conditions: ${chronicContext}

Previous Notes:
${notesContext}

Please analyze these previous notes and provide:
1. A brief summary of relevant previous encounters related to today's complaint
2. Any pertinent findings, assessments, or plans from past visits
3. Pending follow-ups or action items that need attention
4. Relevant chronic condition history that should be considered

Format your response in clear sections with markdown headers.`;

    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LOVABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.2,
        max_tokens: 2000,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('AI gateway error:', response.status, errorText);
      
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: 'Rate limit exceeded.' }), {
          status: 429,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`AI gateway error: ${response.status}`);
    }

    const data = await response.json();
    const analysis = data.choices?.[0]?.message?.content;

    console.log('Context search completed');

    return new Response(JSON.stringify({ 
      analysis,
      hasRelevantHistory: patientNotes && patientNotes.length > 0
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in search-patient-context:', error);
    return new Response(JSON.stringify({ 
      error: error instanceof Error ? error.message : 'Unknown error' 
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});