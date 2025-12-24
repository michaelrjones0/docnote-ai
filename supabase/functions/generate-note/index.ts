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
      noteType, 
      transcript, 
      chiefComplaint, 
      patientContext, 
      previousVisits,
      chronicConditions 
    } = await req.json();

    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) {
      throw new Error('LOVABLE_API_KEY is not configured');
    }

    // Build context from previous visits for chronic conditions
    let previousContextSection = '';
    if (previousVisits && previousVisits.length > 0) {
      previousContextSection = `
## Previous Visit Context (for reference):
${previousVisits.map((v: any) => `
- Date: ${v.date}
  Chief Complaint: ${v.chiefComplaint}
  Summary: ${v.summary || 'N/A'}
`).join('\n')}
`;
    }

    let chronicContextSection = '';
    if (chronicConditions && chronicConditions.length > 0) {
      chronicContextSection = `
## Active Chronic Conditions:
${chronicConditions.map((c: any) => `- ${c.condition_name}${c.icd_code ? ` (${c.icd_code})` : ''}${c.notes ? `: ${c.notes}` : ''}`).join('\n')}
`;
    }

    const noteTemplates: Record<string, string> = {
      'SOAP': `Generate a SOAP note with these sections:
- Subjective: Patient's reported symptoms, history of present illness
- Objective: Physical exam findings, vital signs, test results mentioned
- Assessment: Diagnoses or differential diagnoses
- Plan: Treatment plan, medications, follow-up`,

      'H&P': `Generate a History and Physical note with these sections:
- Chief Complaint
- History of Present Illness (HPI)
- Past Medical History
- Medications
- Allergies
- Social History
- Family History
- Review of Systems
- Physical Examination
- Assessment
- Plan`,

      'Progress': `Generate a Progress Note with these sections:
- Interval History (what's changed since last visit)
- Current Symptoms
- Physical Exam (focused)
- Assessment
- Plan`,

      'Procedure': `Generate a Procedure Note with these sections:
- Procedure Name
- Indication
- Consent
- Anesthesia/Sedation
- Description of Procedure
- Findings
- Specimens (if any)
- Complications
- Estimated Blood Loss (if applicable)
- Disposition/Post-Procedure Plan`
    };

    const systemPrompt = `You are an expert medical scribe assistant. Your task is to generate professional medical documentation from clinical encounter transcripts.

CRITICAL INSTRUCTIONS:
1. Write EVERYTHING from the CLINICIAN'S FIRST-PERSON PERSPECTIVE. Use "I" statements.
   - Example: "I examined the patient..." NOT "The provider examined..."
   - Example: "My assessment is..." NOT "The assessment is..."
   - Example: "I recommend..." NOT "It is recommended..."

2. Be thorough but concise. Include all clinically relevant information from the transcript.

3. Use proper medical terminology while maintaining clarity.

4. If information for a section is not available in the transcript, write "Not documented" for that section.

5. When referencing previous visits or chronic conditions, cite the dates.
   - Example: "Per my notes from 10/20/2024, the patient's A1c was 7.2%..."

6. Format the note in clean markdown with clear section headers.

7. Include any mentioned vital signs, medications, dosages, and follow-up instructions.

${noteTemplates[noteType] || noteTemplates['SOAP']}`;

    const userPrompt = `Generate a ${noteType} note from this clinical encounter.

## Patient Context:
${patientContext || 'No additional context provided'}

## Chief Complaint:
${chiefComplaint || 'Not specified'}

${chronicContextSection}

${previousContextSection}

## Encounter Transcript:
${transcript}

Please generate the ${noteType} note now, written from my perspective as the clinician.`;

    console.log('Generating note with Lovable AI...');
    console.log('Note type:', noteType);

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
        temperature: 0.3,
        max_tokens: 4000,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('AI gateway error:', response.status, errorText);
      
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: 'Rate limit exceeded. Please try again later.' }), {
          status: 429,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: 'AI credits exhausted. Please add funds.' }), {
          status: 402,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`AI gateway error: ${response.status}`);
    }

    const data = await response.json();
    const generatedNote = data.choices?.[0]?.message?.content;

    if (!generatedNote) {
      throw new Error('No content generated');
    }

    console.log('Note generated successfully');

    return new Response(JSON.stringify({ 
      note: generatedNote,
      noteType 
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in generate-note function:', error);
    return new Response(JSON.stringify({ 
      error: error instanceof Error ? error.message : 'Unknown error' 
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});