import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface Preferences {
  detailLevel: 'Brief' | 'Standard' | 'Detailed';
  planFormat: 'Bullets' | 'Paragraph';
  firstPerson: boolean;
  patientQuotes: boolean;
}

const validatePreferences = (prefs: any): Preferences => {
  return {
    detailLevel: ['Brief', 'Standard', 'Detailed'].includes(prefs?.detailLevel) 
      ? prefs.detailLevel 
      : 'Standard',
    planFormat: ['Bullets', 'Paragraph'].includes(prefs?.planFormat) 
      ? prefs.planFormat 
      : 'Bullets',
    firstPerson: typeof prefs?.firstPerson === 'boolean' ? prefs.firstPerson : false,
    patientQuotes: typeof prefs?.patientQuotes === 'boolean' ? prefs.patientQuotes : true,
  };
};

const buildPreferenceInstructions = (prefs: Preferences): string => {
  const instructions: string[] = [];

  // Detail level
  if (prefs.detailLevel === 'Brief') {
    instructions.push('DETAIL LEVEL: Write very concise notes. Use 1-2 sentences per section. Focus on essential clinical information only.');
  } else if (prefs.detailLevel === 'Detailed') {
    instructions.push('DETAIL LEVEL: Write comprehensive notes with more specifics from the transcript. Include relevant context and nuance, but ONLY information present in the transcript.');
  } else {
    instructions.push('DETAIL LEVEL: Write notes with typical clinic note detail - balanced between brevity and completeness.');
  }

  // Plan format
  if (prefs.planFormat === 'Bullets') {
    instructions.push('PLAN FORMAT: Format the plan as a bullet list using "- " prefix for each item.');
  } else {
    instructions.push('PLAN FORMAT: Write the plan as a flowing paragraph, not bullet points.');
  }

  // First person voice
  if (prefs.firstPerson) {
    instructions.push('VOICE: Use first-person clinician voice ("I examined...", "I recommend...").');
  } else {
    instructions.push('VOICE: Use neutral clinical voice. Avoid "I will...", "I plan to...", "I am...". Write in active but impersonal clinical style.');
  }

  // Patient quotes
  if (prefs.patientQuotes) {
    instructions.push('QUOTES: Include direct patient quotes when clinically meaningful (e.g., "Patient states: \'The pain is a 7 out of 10\'").');
  } else {
    instructions.push('QUOTES: Paraphrase patient statements. Do not include direct quotes.');
  }

  return instructions.join('\n\n');
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
      chronicConditions,
      preferences: rawPreferences
    } = await req.json();

    const preferences = validatePreferences(rawPreferences);
    console.log('Preferences applied:', preferences);

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

    const preferenceInstructions = buildPreferenceInstructions(preferences);

    // For SOAP notes, use structured JSON output
    if (noteType === 'SOAP') {
      const soapSystemPrompt = `You are an expert medical scribe assistant. Your task is to generate a SOAP note from clinical encounter transcripts.

## PHYSICIAN PREFERENCES (apply these strictly):
${preferenceInstructions}

## CRITICAL INSTRUCTIONS:

1. SUBJECTIVE:
   - Summarize the patient's reported symptoms and history of present illness.
   - Avoid filler phrases like "presents today" or "comes in today" unless clinically relevant.
   ${preferences.patientQuotes ? '- If the patient gave a direct quote that is clinically meaningful, include it in quotes.' : '- Paraphrase all patient statements; do not use direct quotes.'}
   - Be concise and direct.

2. OBJECTIVE SAFETY RULE - THIS IS CRITICAL AND NON-NEGOTIABLE:
   - Do NOT invent or hallucinate objective data.
   - If the transcript does NOT explicitly include objective findings (vitals, physical exam findings, labs/imaging results, measurements), you MUST set objective to exactly: "Not documented."
   - Do NOT write plausible-sounding exam findings that are not in the transcript.
   - Only include objective data that is EXPLICITLY stated in the transcript.

3. ASSESSMENT - CLINICAL PROBLEM STATEMENT:
   - Write the assessment as a clinical problem statement or diagnosis, NOT meta-language.
   - BAD: "I am assessing the patient for..." or "The assessment is that..."
   - GOOD: "Difficulty solving Rubik's cube" or "Type 2 diabetes mellitus, uncontrolled" or "Acute upper respiratory infection"
   - Be direct and clinical. State the problem or diagnosis.

4. PLAN - ACTIONABLE AND CONCISE:
   - Write the plan as concrete actions taken or to be taken, NOT intentions.
   - BAD: "I plan to work with the patient..." or "We will continue to monitor..."
   - GOOD: ${preferences.planFormat === 'Bullets' ? '"- Reviewed approach\\n- Practiced steps with patient\\n- Follow up in 2 weeks"' : '"Reviewed approach to solving Rubik\'s cube and practiced steps with patient. Follow up scheduled for 2 weeks."'}
   ${preferences.planFormat === 'Bullets' ? '- Format as bullet list with "- " prefix.' : '- Write as a flowing paragraph.'}
   - Use active voice. State what was done or will be done.

5. You must output ONLY valid JSON matching this exact structure:
{
  "soap": {
    "subjective": "string - patient's reported symptoms/history, concise, no filler",
    "objective": "string - exam findings OR 'Not documented.' if none in transcript",
    "assessment": "string - clinical problem statement/diagnosis, NOT meta-language",
    "plan": "string - actionable steps taken/to be taken, NOT intentions"
  },
  "markdown": "formatted markdown note with ## headers for each SOAP section"
}

6. The markdown field should be a nicely formatted clinical note with:
   ## Subjective
   [content]
   
   ## Objective
   [content]
   
   ## Assessment
   [content]
   
   ## Plan
   [content]`;

      const soapUserPrompt = `Generate a SOAP note from this clinical encounter.

## Patient Context:
${patientContext || 'No additional context provided'}

## Chief Complaint:
${chiefComplaint || 'Not specified'}

${chronicContextSection}

${previousContextSection}

## Encounter Transcript:
${transcript}

Remember: 
- Apply the physician preferences strictly.
- For Objective: ONLY include findings explicitly stated in the transcript. If no objective data is mentioned, write "Not documented."
- Output ONLY valid JSON with "soap" object and "markdown" string.`;

      console.log('Generating structured SOAP note with Lovable AI...');

      const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${LOVABLE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'google/gemini-2.5-flash',
          messages: [
            { role: 'system', content: soapSystemPrompt },
            { role: 'user', content: soapUserPrompt }
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
      const rawContent = data.choices?.[0]?.message?.content;

      if (!rawContent) {
        throw new Error('No content generated');
      }

      console.log('Raw AI response:', rawContent);

      // Parse the JSON response
      let parsed;
      try {
        // Try to extract JSON from the response (handle markdown code blocks)
        let jsonStr = rawContent.trim();
        if (jsonStr.startsWith('```json')) {
          jsonStr = jsonStr.slice(7);
        } else if (jsonStr.startsWith('```')) {
          jsonStr = jsonStr.slice(3);
        }
        if (jsonStr.endsWith('```')) {
          jsonStr = jsonStr.slice(0, -3);
        }
        parsed = JSON.parse(jsonStr.trim());
      } catch (parseError) {
        console.error('Failed to parse AI response as JSON:', parseError);
        console.error('Raw content was:', rawContent);
        return new Response(JSON.stringify({ 
          error: 'Failed to parse structured SOAP response from AI',
          details: 'The AI did not return valid JSON'
        }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Validate the structure
      const soap = parsed?.soap;
      if (!soap || 
          typeof soap.subjective !== 'string' ||
          typeof soap.objective !== 'string' ||
          typeof soap.assessment !== 'string' ||
          typeof soap.plan !== 'string') {
        console.error('Invalid SOAP structure:', parsed);
        return new Response(JSON.stringify({ 
          error: 'Invalid SOAP structure from AI',
          details: 'Missing or invalid soap fields (subjective, objective, assessment, plan)'
        }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const markdown = typeof parsed.markdown === 'string' ? parsed.markdown : 
        `## Subjective\n${soap.subjective}\n\n## Objective\n${soap.objective}\n\n## Assessment\n${soap.assessment}\n\n## Plan\n${soap.plan}`;

      console.log('SOAP note generated successfully');

      return new Response(JSON.stringify({ 
        noteType: 'SOAP',
        note: markdown,
        markdown: markdown,
        soap: soap
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // For non-SOAP note types, use the original flow
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