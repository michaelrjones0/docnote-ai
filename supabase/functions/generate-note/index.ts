import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { getCorsHeaders } from "../_shared/env.ts";
import { requireUser, isAuthError } from "../_shared/auth.ts";

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

type PatientGender = 'male' | 'female' | 'other' | '';

interface Preferences {
  noteStructure: 'SOAP' | 'Problem-Oriented';
  detailLevel: 'Brief' | 'Standard' | 'Detailed';
  planFormat: 'Bullets' | 'Paragraph';
  firstPerson: boolean;
  patientQuotes: boolean;
  styleText: string;
  assessmentProblemList: boolean;
  includeFollowUpLine: boolean;
  noteEditorMode: 'SOAP_4_FIELD' | 'SOAP_3_FIELD';
  patientFirstName: string;
  clinicianDisplayName: string;
  patientName: string;
  patientGender: PatientGender;
  normalPhysicalTemplate: string;
  // Selected template content (passed from frontend after resolving template selection)
  selectedPhysicalExamTemplate: string;
}

// Get pronoun set for consistent language
const getPronounSet = (gender: PatientGender): { subject: string; object: string; possessive: string; reflexive: string } => {
  switch (gender) {
    case 'male':
      return { subject: 'he', object: 'him', possessive: 'his', reflexive: 'himself' };
    case 'female':
      return { subject: 'she', object: 'her', possessive: 'her', reflexive: 'herself' };
    case 'other':
    default:
      return { subject: 'they', object: 'them', possessive: 'their', reflexive: 'themselves' };
  }
};

const DEFAULT_NORMAL_PHYSICAL_TEMPLATE = `General: NAD, well-appearing.
HEENT: Normocephalic, atraumatic. PERRL, EOMI. TMs clear. Oropharynx clear.
Neck: Supple, no lymphadenopathy.
CV: RRR, no murmurs, rubs, or gallops.
Lungs: CTA bilaterally, no wheezes, rales, or rhonchi.
Abdomen: Soft, non-tender, non-distended, normoactive bowel sounds.
Extremities: No edema, cyanosis, or clubbing. Full ROM.
Neuro: Alert and oriented x3. CN II-XII intact. Normal gait.`;

const validatePreferences = (prefs: any): Preferences => {
  // Resolve the active template: use selectedPhysicalExamTemplate if provided, else normalPhysicalTemplate
  const selectedTemplate = typeof prefs?.selectedPhysicalExamTemplate === 'string' && prefs.selectedPhysicalExamTemplate.trim()
    ? prefs.selectedPhysicalExamTemplate.slice(0, 2000)
    : (typeof prefs?.normalPhysicalTemplate === 'string' 
        ? prefs.normalPhysicalTemplate.slice(0, 2000) 
        : DEFAULT_NORMAL_PHYSICAL_TEMPLATE);
  
  return {
    noteStructure: ['SOAP', 'Problem-Oriented'].includes(prefs?.noteStructure)
      ? prefs.noteStructure
      : 'SOAP',
    detailLevel: ['Brief', 'Standard', 'Detailed'].includes(prefs?.detailLevel) 
      ? prefs.detailLevel 
      : 'Standard',
    planFormat: ['Bullets', 'Paragraph'].includes(prefs?.planFormat) 
      ? prefs.planFormat 
      : 'Bullets',
    firstPerson: typeof prefs?.firstPerson === 'boolean' ? prefs.firstPerson : false,
    patientQuotes: typeof prefs?.patientQuotes === 'boolean' ? prefs.patientQuotes : true,
    styleText: typeof prefs?.styleText === 'string' ? prefs.styleText.slice(0, 600) : '',
    assessmentProblemList: typeof prefs?.assessmentProblemList === 'boolean' ? prefs.assessmentProblemList : true,
    includeFollowUpLine: typeof prefs?.includeFollowUpLine === 'boolean' ? prefs.includeFollowUpLine : true,
    noteEditorMode: ['SOAP_4_FIELD', 'SOAP_3_FIELD'].includes(prefs?.noteEditorMode)
      ? prefs.noteEditorMode
      : 'SOAP_4_FIELD',
    patientFirstName: typeof prefs?.patientFirstName === 'string' ? prefs.patientFirstName.trim() : '',
    clinicianDisplayName: typeof prefs?.clinicianDisplayName === 'string' ? prefs.clinicianDisplayName.trim() : '',
    patientName: typeof prefs?.patientName === 'string' ? prefs.patientName.trim() : '',
    patientGender: ['male', 'female', 'other'].includes(prefs?.patientGender) ? prefs.patientGender : '',
    normalPhysicalTemplate: typeof prefs?.normalPhysicalTemplate === 'string' 
      ? prefs.normalPhysicalTemplate.slice(0, 2000) 
      : DEFAULT_NORMAL_PHYSICAL_TEMPLATE,
    selectedPhysicalExamTemplate: selectedTemplate,
  };
};

const buildPreferenceInstructions = (prefs: Preferences): string => {
  const instructions: string[] = [];
  const pronouns = getPronounSet(prefs.patientGender);

  // Patient pronoun guidance
  instructions.push(`PATIENT PRONOUNS: Use "${pronouns.subject}/${pronouns.object}/${pronouns.possessive}" pronouns consistently when referring to the patient.
- Subject: ${pronouns.subject} (e.g., "${pronouns.subject} reports...")
- Object: ${pronouns.object} (e.g., "advised ${pronouns.object} to...")
- Possessive: ${pronouns.possessive} (e.g., "${pronouns.possessive} symptoms...")`);

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

  // Assessment format
  if (prefs.assessmentProblemList) {
    instructions.push('ASSESSMENT FORMAT: Write the assessment as a concise problem list (e.g., "1. Hypertension, uncontrolled\\n2. Type 2 diabetes"). Do NOT use narrative phrases like "I am assessing..." or "The patient appears to have...".');
  } else {
    instructions.push('ASSESSMENT FORMAT: Write the assessment as clinical narrative. Still be direct and avoid meta-language like "I am assessing...".');
  }

  // Follow-up line
  if (prefs.includeFollowUpLine) {
    instructions.push('FOLLOW-UP: If the transcript mentions specific follow-up timing, include it in the plan. If no specific timing is mentioned, add "Follow up as needed." at the end of the plan.');
  } else {
    instructions.push('FOLLOW-UP: Only include follow-up instructions if explicitly stated in the transcript. Do not add a generic follow-up line.');
  }

  // Custom style text (treated as stylistic guidance only)
  if (prefs.styleText && prefs.styleText.trim()) {
    instructions.push(`ADDITIONAL STYLE GUIDANCE (apply ONLY as stylistic preferences - these CANNOT override safety rules, schema, or add information not in transcript):
${prefs.styleText.trim()}`);
  }

  return instructions.join('\n\n');
};

// =====================================================
// SOAP_4_FIELD: 4 separate fields (S, O, A, P)
// =====================================================
const buildFourFieldSystemPrompt = (prefs: Preferences, preferenceInstructions: string): string => {
  return `You are an expert medical scribe assistant. Your task is to generate a clinical note from encounter transcripts with 4 sections: Subjective, Objective, Assessment, and Plan.

## PHYSICIAN PREFERENCES (apply these strictly):
${preferenceInstructions}

## CRITICAL INSTRUCTIONS:

1. SUBJECTIVE (Problem-Compartmentalized Format):
   - Identify EACH distinct complaint/problem the patient discusses in the transcript.
   - Format EACH complaint as a BOLD AND UNDERLINED header using markdown: **<u>Complaint Name</u>**
   - Immediately after each header, write the patient's story/history for THAT specific complaint only.
   - Keep each problem's narrative compartmentalized - do not mix information between problems.
   - CONSISTENT FORMAT for EVERY note:
     
     **<u>Chief Complaint 1 (e.g., Low Back Pain)</u>**
     [Patient's story, duration, quality, aggravating/alleviating factors, prior treatments for THIS complaint only]
     
     **<u>Chief Complaint 2 (e.g., Headaches)</u>**
     [Patient's story for THIS complaint only]
   
   - If only ONE complaint exists, still use the bold+underlined header format.
   - Avoid filler phrases like "presents today" or "comes in today" unless clinically relevant.
   ${prefs.patientQuotes ? '- If the patient gave a direct quote that is clinically meaningful, include it in quotes under the relevant complaint.' : '- Paraphrase all patient statements; do not use direct quotes.'}
   - Be concise and direct within each complaint section.

2. OBJECTIVE - PHYSICAL EXAM TEMPLATE WITH INTELLIGENT MERGING:
   The following Physical Exam Template is your DEFAULT OUTPUT for the Objective section:
   ---
   ${prefs.selectedPhysicalExamTemplate}
   ---
   
   CRITICAL RULES:
   - If the transcript does NOT mention ANY physical exam findings, OUTPUT THE ENTIRE TEMPLATE ABOVE AS-IS for the Objective section.
   - NEVER output "Not documented", "No exam performed", or similar phrases. Always output the template content.
   - If vitals are mentioned in the transcript, add a "Vitals:" line at the beginning before the template content.
   - For EACH body system mentioned in the transcript with SPECIFIC findings (pertinent positives), REPLACE that system's template text with the actual findings from the transcript.
   - For body systems NOT mentioned in the transcript, KEEP the template's default (normal) findings exactly as written.
   - Do NOT invent findings beyond what's in the template or explicitly stated in the transcript.
   
   Example: If template says "CV: RRR, no murmurs" but transcript mentions "patient has a 2/6 systolic murmur", output "CV: RRR, 2/6 systolic murmur heard."

3. ASSESSMENT:
   - State the clinical problem(s)/diagnosis(es).
   ${prefs.assessmentProblemList ? '- Format as a numbered problem list.' : '- Write as clinical narrative.'}
   - BAD: "I am assessing the patient for..." or "The assessment is that..."
   - GOOD: "1. Hypertension, uncontrolled" or "1. Acute low back pain"

4. PLAN:
   - State what will be done for each problem.
   ${prefs.planFormat === 'Bullets' ? '- Format as bullet list with "- " prefix.' : '- Write as flowing paragraph.'}
   - Use active voice.
   ${prefs.includeFollowUpLine ? '- End with follow-up timing if mentioned, otherwise "Follow up as needed."' : ''}

5. PATIENT INSTRUCTIONS (patientInstructions):
   - Write a friendly, plain-language letter to the patient summarizing what was discussed.
   - Start with a greeting: "${prefs.patientName ? `Hi ${prefs.patientName},` : 'Hi there,'}"
   - Include: medications prescribed/adjusted, home care instructions, warning signs to watch for, follow-up timing, when to go to ER/urgent care.
   - Use simple non-medical language whenever possible.
   - End with a closing and clinician signature:
     "Sincerely,
     ${prefs.clinicianDisplayName || 'Dr. [Your Name]'}"
   - Do NOT sign with the patient's name anywhere.

6. You must output ONLY valid JSON matching this exact structure:
{
  "soap": {
    "subjective": "string",
    "objective": "string - exam findings from transcript OR Normal Physical template if none mentioned",
    "assessment": "string",
    "plan": "string"
  },
  "patientInstructions": "string - friendly letter to patient",
  "markdown": "formatted markdown note with ## headers for each section"
}

7. The markdown field should be a nicely formatted clinical note with:
   ## Subjective
   [content]
   
   ## Objective
   [content]
   
   ## Assessment
   [content]
   
   ## Plan
   [content]`;
};

// =====================================================
// SOAP_3_FIELD: 3 sections (S, O, A/P combined)
// =====================================================
const buildThreeFieldSystemPrompt = (prefs: Preferences, preferenceInstructions: string): string => {
  return `You are an expert medical scribe assistant. Your task is to generate a clinical note from encounter transcripts with 3 sections: Subjective, Objective, and Assessment & Plan (combined).

## PHYSICIAN PREFERENCES (apply these strictly):
${preferenceInstructions}

## CRITICAL INSTRUCTIONS:

1. SUBJECTIVE (Problem-Compartmentalized Format):
   - Identify EACH distinct complaint/problem the patient discusses in the transcript.
   - Format EACH complaint as a BOLD AND UNDERLINED header using markdown: **<u>Complaint Name</u>**
   - Immediately after each header, write the patient's story/history for THAT specific complaint only.
   - Keep each problem's narrative compartmentalized - do not mix information between problems.
   - CONSISTENT FORMAT for EVERY note:
     
     **<u>Chief Complaint 1 (e.g., Low Back Pain)</u>**
     [Patient's story, duration, quality, aggravating/alleviating factors, prior treatments for THIS complaint only]
     
     **<u>Chief Complaint 2 (e.g., Headaches)</u>**
     [Patient's story for THIS complaint only]
   
   - If only ONE complaint exists, still use the bold+underlined header format.
   - Avoid filler phrases like "presents today" or "comes in today" unless clinically relevant.
   ${prefs.patientQuotes ? '- If the patient gave a direct quote that is clinically meaningful, include it in quotes under the relevant complaint.' : '- Paraphrase all patient statements; do not use direct quotes.'}
   - Be concise and direct within each complaint section.

2. OBJECTIVE - PHYSICAL EXAM TEMPLATE WITH INTELLIGENT MERGING:
   The following Physical Exam Template is your DEFAULT OUTPUT for the Objective section:
   ---
   ${prefs.selectedPhysicalExamTemplate}
   ---
   
   CRITICAL RULES:
   - If the transcript does NOT mention ANY physical exam findings, OUTPUT THE ENTIRE TEMPLATE ABOVE AS-IS for the Objective section.
   - NEVER output "Not documented", "No exam performed", or similar phrases. Always output the template content.
   - If vitals are mentioned in the transcript, add a "Vitals:" line at the beginning before the template content.
   - For EACH body system mentioned in the transcript with SPECIFIC findings (pertinent positives), REPLACE that system's template text with the actual findings from the transcript.
   - For body systems NOT mentioned in the transcript, KEEP the template's default (normal) findings exactly as written.
   - Do NOT invent findings beyond what's in the template or explicitly stated in the transcript.
   
   Example: If template says "Lungs: CTA bilaterally" but transcript mentions "crackles in right lower lobe", output "Lungs: Crackles in right lower lobe."

3. ASSESSMENT & PLAN (COMBINED - PROBLEM-ORIENTED):
   - For EACH distinct clinical problem discussed, create an entry in the "ap" array.
   - The "assessmentPlan" field must be generated FROM the "ap" array entries.
   - Format assessmentPlan as:
     Problem 1: <problem name>
     Assessment: <one sentence clinical assessment>
     Plan:
     - bullet item
     - bullet item
     
     Problem 2: <problem name>
     Assessment: <one sentence clinical assessment>
     Plan:
     - bullet item
   
   - If only ONE problem exists, still format the same way with one entry.
   - Do NOT merge multiple problems into one generic plan.
   - BAD: "I am assessing the patient for..."
    - GOOD: "Problem 1: Hypertension, uncontrolled\\nAssessment: Blood pressure remains elevated despite current medication.\\nPlan:\\n- Increase lisinopril to 20mg daily"

4. PATIENT INSTRUCTIONS (patientInstructions):
   - Write a friendly, plain-language letter to the patient summarizing what was discussed.
   - Start with a greeting: "${prefs.patientName ? `Hi ${prefs.patientName},` : 'Hi there,'}"
   - Include: medications prescribed/adjusted, home care instructions, warning signs to watch for, follow-up timing, when to go to ER/urgent care.
   - Use simple non-medical language whenever possible.
   - End with a closing and clinician signature:
     "Sincerely,
     ${prefs.clinicianDisplayName || 'Dr. [Your Name]'}"
   - Do NOT sign with the patient's name anywhere.

5. You must output ONLY valid JSON matching this exact structure:
{
  "soap3": {
    "subjective": "string",
    "objective": "string - exam findings from transcript OR Normal Physical template if none mentioned",
    "assessmentPlan": "string - formatted problem-oriented A/P"
  },
  "ap": [
    {
      "problem": "string - problem name",
      "assessment": "string - one sentence assessment",
      "plan": ["string - plan item 1", "string - plan item 2"]
    }
  ],
  "patientInstructions": "string - friendly letter to patient",
  "markdown": "formatted markdown note with ## headers"
}

6. The markdown field should be:
   ## Subjective
   [content]
   
   ## Objective
   [content]
   
   ## Assessment & Plan
   [problem-oriented content matching assessmentPlan field]`;
};

const buildProblemOrientedFourFieldPrompt = (prefs: Preferences, preferenceInstructions: string): string => {
  const detailSentences = prefs.detailLevel === 'Brief' ? '1-2' : prefs.detailLevel === 'Detailed' ? '4-6' : '3-4';
  
  return `You are an expert medical scribe assistant. Your task is to generate a PROBLEM-ORIENTED clinical note from encounter transcripts with 4 sections: Subjective, Objective, Assessment, and Plan.

## PHYSICIAN PREFERENCES (apply these strictly):
${preferenceInstructions}

## CRITICAL INSTRUCTIONS:

1. TRANSCRIPT-ONLY CONSTRAINT:
   - Only include information explicitly present in the transcript.
   - Do NOT invent or extrapolate clinical information.

2. SUBJECTIVE (Problem-Compartmentalized Format):
   - Identify EACH distinct complaint/problem the patient discusses in the transcript.
   - Format EACH complaint as a BOLD AND UNDERLINED header using markdown: **<u>Complaint Name</u>**
   - Immediately after each header, write the patient's story/history for THAT specific complaint only.
   - Keep each problem's narrative compartmentalized - do not mix information between problems.
   - CONSISTENT FORMAT for EVERY note:
     
     **<u>Chief Complaint 1 (e.g., Low Back Pain)</u>**
     [Patient's story, duration, quality, aggravating/alleviating factors, prior treatments for THIS complaint only - ${detailSentences} sentences]
     
     **<u>Chief Complaint 2 (e.g., Headaches)</u>**
     [Patient's story for THIS complaint only - ${detailSentences} sentences]
   
   - If only ONE complaint exists, still use the bold+underlined header format.
   ${prefs.patientQuotes ? '- Include at least one direct patient quote if clinically meaningful, under the relevant complaint.' : '- Paraphrase all patient statements; do not use direct quotes.'}

3. OBJECTIVE - PHYSICAL EXAM TEMPLATE WITH INTELLIGENT MERGING:
   The following Physical Exam Template is your DEFAULT OUTPUT for the Objective section:
   ---
   ${prefs.selectedPhysicalExamTemplate}
   ---
   
   CRITICAL RULES:
   - If the transcript does NOT mention ANY physical exam findings, OUTPUT THE ENTIRE TEMPLATE ABOVE AS-IS for the Objective section.
   - NEVER output "Not documented", "No exam performed", or similar phrases. Always output the template content.
   - If vitals are mentioned in the transcript, add a "Vitals:" line at the beginning before the template content.
   - For EACH body system mentioned in the transcript with SPECIFIC findings (pertinent positives), REPLACE that system's template text with the actual findings from the transcript.
   - For body systems NOT mentioned in the transcript, KEEP the template's default (normal) findings.
   - Organize by system (Vitals, General, CV, Resp, GI, MSK, Neuro, etc.).
   - If vitals are mentioned, add a "Vitals:" line at the beginning.
   - Do NOT invent findings beyond what's in the template or explicitly stated in the transcript.

4. ASSESSMENT (Problem-Oriented Format):
   - Create a NUMBERED problem list with clinical impression for each.
   ${prefs.assessmentProblemList ? '- Format as numbered list.' : '- Write as clinical narrative.'}

5. PLAN (Problem-Oriented Format):
   - For each problem include plan items.
   ${prefs.planFormat === 'Bullets' ? '- Format as bullet list with "- " prefix.' : '- Write as a flowing paragraph.'}
   ${prefs.includeFollowUpLine ? '- If follow-up timing not stated, end with "Follow up as needed."' : '- Only include follow-up if explicitly stated in transcript.'}

6. PATIENT INSTRUCTIONS (patientInstructions):
   - Write a friendly, plain-language letter to the patient summarizing what was discussed.
   - Start with a greeting: "${prefs.patientName ? `Hi ${prefs.patientName},` : 'Hi there,'}"
   - Include: medications prescribed/adjusted, home care instructions, warning signs to watch for, follow-up timing, when to go to ER/urgent care.
   - Use simple non-medical language whenever possible.
   - End with a closing and clinician signature:
     "Sincerely,
     ${prefs.clinicianDisplayName || 'Dr. [Your Name]'}"
   - Do NOT sign with the patient's name anywhere.

7. You must output ONLY valid JSON matching this exact structure:
{
  "soap": {
    "subjective": "string - full subjective content (problem-oriented format)",
    "objective": "string - exam findings from transcript OR Normal Physical template if none mentioned",
    "assessment": "string - problem list or clinical narrative",
    "plan": "string - plan items"
  },
  "patientInstructions": "string - friendly letter to patient",
  "markdown": "formatted problem-oriented markdown note"
}

8. The markdown field should be formatted as:
   ## Subjective
   [problem-oriented subjective content - use ### Problem Name headers if multiple problems]
   
   ## Objective
   [system-based findings - USE TEMPLATE IF NO EXAM IN TRANSCRIPT]
   
   ## Assessment
   1. **Problem Name** - [assessment text]
   2. **Next Problem** - [assessment text]
   
   ## Plan
   - [plan items organized by problem if multiple]`;
};

const buildProblemOrientedThreeFieldPrompt = (prefs: Preferences, preferenceInstructions: string): string => {
  const detailSentences = prefs.detailLevel === 'Brief' ? '1-2' : prefs.detailLevel === 'Detailed' ? '4-6' : '3-4';
  
  return `You are an expert medical scribe assistant. Your task is to generate a PROBLEM-ORIENTED clinical note from encounter transcripts with 3 sections: Subjective, Objective, and Assessment & Plan (combined).

## PHYSICIAN PREFERENCES (apply these strictly):
${preferenceInstructions}

## CRITICAL INSTRUCTIONS:

1. TRANSCRIPT-ONLY CONSTRAINT:
   - Only include information explicitly present in the transcript.
   - Do NOT invent or extrapolate clinical information.

2. SUBJECTIVE (Problem-Compartmentalized Format):
   - Identify EACH distinct complaint/problem the patient discusses in the transcript.
   - Format EACH complaint as a BOLD AND UNDERLINED header using markdown: **<u>Complaint Name</u>**
   - Immediately after each header, write the patient's story/history for THAT specific complaint only.
   - Keep each problem's narrative compartmentalized - do not mix information between problems.
   - CONSISTENT FORMAT for EVERY note:
     
     **<u>Chief Complaint 1 (e.g., Low Back Pain)</u>**
     [Patient's story, duration, quality, aggravating/alleviating factors, prior treatments for THIS complaint only - ${detailSentences} sentences]
     
     **<u>Chief Complaint 2 (e.g., Headaches)</u>**
     [Patient's story for THIS complaint only - ${detailSentences} sentences]
   
   - If only ONE complaint exists, still use the bold+underlined header format.
   ${prefs.patientQuotes ? '- Include at least one direct patient quote if clinically meaningful, under the relevant complaint.' : '- Paraphrase all patient statements; do not use direct quotes.'}

3. OBJECTIVE - PHYSICAL EXAM TEMPLATE WITH INTELLIGENT MERGING:
   The following Physical Exam Template is your DEFAULT OUTPUT for the Objective section:
   ---
   ${prefs.selectedPhysicalExamTemplate}
   ---
   
   CRITICAL RULES:
   - If the transcript does NOT mention ANY physical exam findings, OUTPUT THE ENTIRE TEMPLATE ABOVE AS-IS for the Objective section.
   - NEVER output "Not documented", "No exam performed", or similar phrases. Always output the template content.
   - If vitals are mentioned in the transcript, add a "Vitals:" line at the beginning before the template content.
   - For EACH body system mentioned in the transcript with SPECIFIC findings (pertinent positives), REPLACE that system's template text with the actual findings from the transcript.
   - For body systems NOT mentioned in the transcript, KEEP the template's default (normal) findings exactly as written.
   - Organize by system (Vitals, General, CV, Resp, GI, MSK, Neuro, etc.).
   - Do NOT invent findings beyond what's in the template or explicitly stated in the transcript.

4. ASSESSMENT & PLAN (Combined, Problem-Oriented Format):
   - For EACH distinct clinical problem discussed, create an entry in the "ap" array.
   - The "assessmentPlan" field must be generated FROM the "ap" array entries.
   - Format assessmentPlan as:
     Problem 1: <problem name>
     Assessment: <one sentence clinical assessment>
     Plan:
     - bullet item
     - bullet item
   
   - If only ONE problem exists, still format the same way.
   ${prefs.includeFollowUpLine ? '- End each problem\'s plan with follow-up if stated, or add "Follow up as needed." for last problem.' : '- Only include follow-up if explicitly stated in transcript.'}

5. PATIENT INSTRUCTIONS (patientInstructions):
   - Write a friendly, plain-language letter to the patient summarizing what was discussed.
   - Start with a greeting: "${prefs.patientName ? `Hi ${prefs.patientName},` : 'Hi there,'}"
   - Include: medications prescribed/adjusted, home care instructions, warning signs to watch for, follow-up timing, when to go to ER/urgent care.
   - Use simple non-medical language whenever possible.
   - End with a closing and clinician signature:
     "Sincerely,
     ${prefs.clinicianDisplayName || 'Dr. [Your Name]'}"
   - Do NOT sign with the patient's name anywhere.

6. You must output ONLY valid JSON matching this exact structure:
{
  "soap3": {
    "subjective": "string - problem-oriented subjective",
    "objective": "string - exam findings from transcript OR Normal Physical template if none mentioned",
    "assessmentPlan": "string - problem-oriented A/P"
  },
  "ap": [
    {
      "problem": "string",
      "assessment": "string",
      "plan": ["string", "string"]
    }
  ],
  "patientInstructions": "string - friendly letter to patient",
  "markdown": "formatted problem-oriented markdown note"
}

7. The markdown field should be:
   ## Subjective
   [problem-oriented content]
   
   ## Objective
   [system-based findings OR "Not documented."]
   
   ## Assessment & Plan
   [problem-oriented A/P matching assessmentPlan field]`;
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
    console.log('[generate-note] Request received:', {
      noteType,
      transcriptLength: transcript?.length ?? 0,
      hasPreferences: !!rawPreferences,
      noteEditorMode: preferences.noteEditorMode,
      noteStructure: preferences.noteStructure,
    });

    // Use OpenAI API directly
    const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY');
    if (!OPENAI_API_KEY) {
      console.error('[generate-note] OPENAI_API_KEY not found');
      return buildErrorResponse(
        'AI API key not configured',
        500,
        corsHeaders,
        { message: 'OPENAI_API_KEY is missing from environment variables' }
      );
    }
    
    console.log('[generate-note] OPENAI_API_KEY present, length:', OPENAI_API_KEY.length);

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

    // For SOAP note types
    if (noteType === 'SOAP') {
      const isProblemOriented = preferences.noteStructure === 'Problem-Oriented';
      const is4Field = preferences.noteEditorMode === 'SOAP_4_FIELD';
      
      // Select the right prompt based on mode and structure
      let systemPrompt: string;
      if (is4Field) {
        systemPrompt = isProblemOriented
          ? buildProblemOrientedFourFieldPrompt(preferences, preferenceInstructions)
          : buildFourFieldSystemPrompt(preferences, preferenceInstructions);
      } else {
        systemPrompt = isProblemOriented
          ? buildProblemOrientedThreeFieldPrompt(preferences, preferenceInstructions)
          : buildThreeFieldSystemPrompt(preferences, preferenceInstructions);
      }

      const userPrompt = `Generate a ${isProblemOriented ? 'Problem-Oriented' : 'clinical'} note from this encounter.

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
- For Objective: Use the Physical Exam Template as the baseline. Merge any pertinent positives from the transcript. If no exam findings in transcript, output the template AS-IS.
- Output mode: ${is4Field ? 'SOAP_4_FIELD (4 separate fields: S, O, A, P)' : 'SOAP_3_FIELD (3 fields: S, O, A/P combined)'}
- Output ONLY valid JSON.`;

      console.log('[generate-note] Calling OpenAI API:', {
        model: 'gpt-4o-mini',
        isProblemOriented,
        is4Field,
      });

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.3,
          max_tokens: 4000,
        }),
      });

      console.log('[generate-note] OpenAI response status:', response.status);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[generate-note] OpenAI API error:', {
          status: response.status,
          statusText: response.statusText,
          errorBody: errorText,
        });
        
        if (response.status === 429) {
          return buildErrorResponse(
            'Rate limit exceeded. Please try again later.',
            429,
            corsHeaders,
            { details: errorText }
          );
        }
        if (response.status === 401) {
          return buildErrorResponse(
            'AI authentication failed',
            500,
            corsHeaders,
            { message: 'OpenAI API key is invalid', details: errorText }
          );
        }
        if (response.status === 402 || response.status === 403) {
          return buildErrorResponse(
            'AI quota exceeded or access denied',
            402,
            corsHeaders,
            { details: errorText }
          );
        }
        return buildErrorResponse(
          'Failed to generate note',
          500,
          corsHeaders,
          { message: `OpenAI API error: ${response.status}`, details: errorText }
        );
      }

      const data = await response.json();
      const rawContent = data.choices?.[0]?.message?.content;

      console.log('[generate-note] OpenAI response received:', {
        hasContent: !!rawContent,
        contentLength: rawContent?.length ?? 0,
        usage: data.usage,
      });

      if (!rawContent) {
        return buildErrorResponse(
          'No content generated',
          500,
          corsHeaders,
          { message: 'OpenAI returned empty response' }
        );
      }

      console.log('[generate-note] Raw AI response:', rawContent.slice(0, 500));

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
        console.error('[generate-note] Failed to parse AI response as JSON:', parseError);
        console.error('[generate-note] Raw content was:', rawContent);
        return buildErrorResponse(
          'Failed to parse structured response from AI',
          500,
          corsHeaders,
          { message: 'The AI did not return valid JSON', details: rawContent.slice(0, 500) }
        );
      }

      // =====================================================
      // SOAP_4_FIELD: Validate and return 4-field structure
      // =====================================================
      if (is4Field) {
        const soap = parsed?.soap;
        if (!soap || 
            typeof soap.subjective !== 'string' ||
            typeof soap.objective !== 'string' ||
            typeof soap.assessment !== 'string' ||
            typeof soap.plan !== 'string') {
          console.error('[generate-note] Invalid 4-field note structure:', parsed);
          return buildErrorResponse(
            'Invalid note structure from AI',
            500,
            corsHeaders,
            { 
              message: 'Missing or invalid fields (subjective, objective, assessment, plan)',
              details: JSON.stringify(parsed).slice(0, 500)
            }
          );
        }

        const markdown = typeof parsed.markdown === 'string' ? parsed.markdown : 
          `## Subjective\n${soap.subjective}\n\n## Objective\n${soap.objective}\n\n## Assessment\n${soap.assessment}\n\n## Plan\n${soap.plan}`;

        // Extract patient instructions
        const patientInstructions = typeof parsed.patientInstructions === 'string' ? parsed.patientInstructions : '';

        // Build patient info for self-contained export
        const pronouns = getPronounSet(preferences.patientGender);
        const patientInfo = {
          patientName: preferences.patientName,
          patientGender: preferences.patientGender || 'other',
          patientPronouns: {
            subject: pronouns.subject,
            object: pronouns.object,
            possessive: pronouns.possessive,
          },
        };

        console.log('[generate-note] SOAP_4_FIELD note generated successfully');

        return new Response(JSON.stringify({ 
          noteType: 'SOAP_4_FIELD',
          note: markdown,
          markdown: markdown,
          soap: soap, // Contains: subjective, objective, assessment, plan
          patientInstructions,
          ...patientInfo,
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // =====================================================
      // SOAP_3_FIELD: Validate and return 3-field structure
      // =====================================================
      const soap3 = parsed?.soap3;
      const ap = parsed?.ap;
      
      if (!soap3 || 
          typeof soap3.subjective !== 'string' ||
          typeof soap3.objective !== 'string' ||
          typeof soap3.assessmentPlan !== 'string') {
        console.error('[generate-note] Invalid 3-field note structure:', parsed);
        return buildErrorResponse(
          'Invalid note structure from AI',
          500,
          corsHeaders,
          { 
            message: 'Missing or invalid fields (subjective, objective, assessmentPlan)',
            details: JSON.stringify(parsed).slice(0, 500)
          }
        );
      }

      // Validate ap array if present
      let validatedAp: Array<{ problem: string; assessment: string; plan: string[] }> = [];
      if (Array.isArray(ap)) {
        validatedAp = ap.filter(entry => 
          entry && 
          typeof entry.problem === 'string' && 
          typeof entry.assessment === 'string' &&
          Array.isArray(entry.plan)
        ).map(entry => ({
          problem: entry.problem,
          assessment: entry.assessment,
          plan: entry.plan.map((p: any) => String(p))
        }));
      }

      const markdown = typeof parsed.markdown === 'string' ? parsed.markdown : 
        `## Subjective\n${soap3.subjective}\n\n## Objective\n${soap3.objective}\n\n## Assessment & Plan\n${soap3.assessmentPlan}`;

      // Extract patient instructions
      const patientInstructions = typeof parsed.patientInstructions === 'string' ? parsed.patientInstructions : '';

      // Build patient info for self-contained export
      const pronouns = getPronounSet(preferences.patientGender);
      const patientInfo = {
        patientName: preferences.patientName,
        patientGender: preferences.patientGender || 'other',
        patientPronouns: {
          subject: pronouns.subject,
          object: pronouns.object,
          possessive: pronouns.possessive,
        },
      };

      console.log('[generate-note] SOAP_3_FIELD note generated successfully with', validatedAp.length, 'problems');

      return new Response(JSON.stringify({ 
        noteType: 'SOAP_3_FIELD',
        note: markdown,
        markdown: markdown,
        soap3: soap3, // Contains: subjective, objective, assessmentPlan
        ap: validatedAp,
        patientInstructions,
        ...patientInfo,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // For non-SOAP note types, use the original flow
    const noteTemplates: Record<string, string> = {
      'SOAP': `Generate a clinical note with these sections:
- Subjective: Patient's reported symptoms, history of present illness
- Objective: Physical exam findings, vital signs, test results mentioned
- Assessment & Plan: Combined diagnoses and treatment plan`,

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

    console.log('[generate-note] Generating non-SOAP note with OpenAI:', {
      noteType,
      model: 'gpt-4o-mini',
    });

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.3,
        max_tokens: 4000,
      }),
    });

    console.log('[generate-note] OpenAI response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[generate-note] OpenAI API error:', {
        status: response.status,
        statusText: response.statusText,
        errorBody: errorText,
      });
      
      if (response.status === 429) {
        return buildErrorResponse(
          'Rate limit exceeded. Please try again later.',
          429,
          corsHeaders,
          { details: errorText }
        );
      }
      if (response.status === 401) {
        return buildErrorResponse(
          'AI authentication failed',
          500,
          corsHeaders,
          { message: 'OpenAI API key is invalid', details: errorText }
        );
      }
      return buildErrorResponse(
        'Failed to generate note',
        500,
        corsHeaders,
        { message: `OpenAI API error: ${response.status}`, details: errorText }
      );
    }

    const data = await response.json();
    const generatedNote = data.choices?.[0]?.message?.content;

    console.log('[generate-note] OpenAI response received:', {
      hasContent: !!generatedNote,
      usage: data.usage,
    });

    if (!generatedNote) {
      return buildErrorResponse(
        'No content generated',
        500,
        corsHeaders,
        { message: 'OpenAI returned empty response' }
      );
    }

    console.log('[generate-note] Non-SOAP note generated successfully');

    return new Response(JSON.stringify({ 
      note: generatedNote,
      noteType 
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('[generate-note] Unhandled error:', {
      message: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      error,
    });
    // Re-derive CORS for catch block (origin may not be available if parsing failed early)
    const origin = req.headers.get('Origin');
    const { headers: catchCorsHeaders } = getCorsHeaders(origin);
    return buildErrorResponse(
      'An unexpected error occurred',
      500,
      catchCorsHeaders,
      {
        message: error instanceof Error ? error.message : 'Unknown server error',
        stack: error instanceof Error ? error.stack : undefined,
      }
    );
  }
});
