import "https://deno.land/x/xhr@0.1.0/mod.ts";
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
    const { currentNote, instruction } = await req.json();

    if (!instruction) {
      throw new Error('No instruction provided');
    }

    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) {
      throw new Error('LOVABLE_API_KEY not configured');
    }

    console.log('Processing voice instruction for note editing...');
    console.log('Instruction:', instruction);

    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LOVABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          {
            role: 'system',
            content: `You are a clinical documentation assistant helping edit medical notes. 
You will receive the current note content and an instruction from the clinician.
Apply the instruction to modify the note appropriately.
Maintain proper medical documentation standards and formatting.
Return ONLY the modified note content, no explanations or preamble.
If the instruction is unclear, make your best interpretation and apply it.
Common instructions include:
- Making sections more concise
- Converting to bullet points
- Expanding sections with more detail
- Correcting grammar or formatting
- Adding or removing specific content`
          },
          {
            role: 'user',
            content: `Current note:\n\n${currentNote || '(empty note)'}\n\nInstruction: ${instruction}`
          }
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('AI edit error:', response.status, errorText);
      
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: 'Rate limit exceeded, please try again later.' }), {
          status: 429,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: 'Payment required, please add funds.' }), {
          status: 402,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      
      throw new Error(`AI edit failed: ${response.status}`);
    }

    const data = await response.json();
    const editedNote = data.choices?.[0]?.message?.content || currentNote;

    console.log('Note editing completed');

    return new Response(
      JSON.stringify({ editedNote }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in edit-note-voice:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
