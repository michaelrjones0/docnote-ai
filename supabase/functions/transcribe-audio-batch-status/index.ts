import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { getCorsHeaders, getAwsConfig } from "../_shared/env.ts";

async function hmacSHA256(key: ArrayBuffer | Uint8Array, message: string): Promise<ArrayBuffer> {
  let keyBuffer: ArrayBuffer;
  if (key instanceof Uint8Array) {
    keyBuffer = new Uint8Array(key).buffer as ArrayBuffer;
  } else {
    keyBuffer = key as ArrayBuffer;
  }
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
}

async function sha256(message: string | Uint8Array): Promise<string> {
  const data = typeof message === 'string' ? new TextEncoder().encode(message) : new Uint8Array(message);
  const hash = await crypto.subtle.digest('SHA-256', data.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function signRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string,
  service: string,
  region: string,
  accessKeyId: string,
  secretAccessKey: string
): Promise<Record<string, string>> {
  const urlObj = new URL(url);
  const host = urlObj.host;
  const path = urlObj.pathname;
  const queryString = urlObj.search.slice(1);

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  
  const payloadHash = await sha256(body);
  
  // Normalize ALL header names to lowercase BEFORE any processing
  const normalizedHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalizedHeaders[key.toLowerCase()] = value;
  }
  
  // Add required headers (already lowercase)
  normalizedHeaders['host'] = host;
  normalizedHeaders['x-amz-date'] = amzDate;
  normalizedHeaders['x-amz-content-sha256'] = payloadHash;

  // Sort lowercase header names
  const sortedHeaderKeys = Object.keys(normalizedHeaders).sort();
  
  // Build canonical headers using lowercase names and trimmed values
  const canonicalHeaders = sortedHeaderKeys.map(k => `${k}:${normalizedHeaders[k].trim()}\n`).join('');
  const signedHeadersStr = sortedHeaderKeys.join(';');

  const canonicalRequest = [
    method,
    path,
    queryString,
    canonicalHeaders,
    signedHeadersStr,
    payloadHash
  ].join('\n');

  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const canonicalRequestHash = await sha256(canonicalRequest);
  
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    canonicalRequestHash
  ].join('\n');

  const kDate = await hmacSHA256(new TextEncoder().encode('AWS4' + secretAccessKey), dateStamp);
  const kRegion = await hmacSHA256(kDate, region);
  const kService = await hmacSHA256(kRegion, service);
  const kSigning = await hmacSHA256(kService, 'aws4_request');
  
  const signatureBytes = await hmacSHA256(kSigning, stringToSign);
  const signature = Array.from(new Uint8Array(signatureBytes)).map(b => b.toString(16).padStart(2, '0')).join('');

  const authHeader = `${algorithm} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeadersStr}, Signature=${signature}`;

  return {
    ...normalizedHeaders,
    'authorization': authHeader,
  };
}

interface TranscriptSegment {
  content: string;
  speaker: string;
  startMs: number;
  endMs: number;
}

function parseTranscriptWithSpeakers(transcriptData: any): { text: string; segments: TranscriptSegment[] } {
  const results = transcriptData.results;
  const transcriptText = results?.transcripts?.[0]?.transcript || '';
  const segments: TranscriptSegment[] = [];

  const speakerLabels = results?.speaker_labels;
  const items = results?.items || [];

  if (speakerLabels?.segments) {
    for (const segment of speakerLabels.segments) {
      const speaker = segment.speaker_label || 'spk_0';
      const startMs = Math.round(parseFloat(segment.start_time || '0') * 1000);
      const endMs = Math.round(parseFloat(segment.end_time || '0') * 1000);
      
      const segmentItems = segment.items || [];
      const words: string[] = [];
      
      for (const item of segmentItems) {
        const contentItem = items.find((ci: any) => 
          ci.start_time === item.start_time && ci.end_time === item.end_time
        );
        if (contentItem?.alternatives?.[0]?.content) {
          words.push(contentItem.alternatives[0].content);
        }
      }
      
      if (words.length > 0) {
        segments.push({
          content: words.join(' '),
          speaker,
          startMs,
          endMs
        });
      }
    }
  } else if (items.length > 0) {
    let currentSegment: { words: string[]; startMs: number; endMs: number } | null = null;
    
    for (const item of items) {
      if (item.type === 'pronunciation') {
        const word = item.alternatives?.[0]?.content || '';
        const startMs = Math.round(parseFloat(item.start_time || '0') * 1000);
        const endMs = Math.round(parseFloat(item.end_time || '0') * 1000);
        
        if (!currentSegment) {
          currentSegment = { words: [word], startMs, endMs };
        } else if (startMs - currentSegment.endMs > 2000) {
          segments.push({
            content: currentSegment.words.join(' '),
            speaker: 'spk_0',
            startMs: currentSegment.startMs,
            endMs: currentSegment.endMs
          });
          currentSegment = { words: [word], startMs, endMs };
        } else {
          currentSegment.words.push(word);
          currentSegment.endMs = endMs;
        }
      } else if (item.type === 'punctuation' && currentSegment) {
        const lastWord = currentSegment.words.pop();
        if (lastWord) {
          currentSegment.words.push(lastWord + (item.alternatives?.[0]?.content || ''));
        }
      }
    }
    
    if (currentSegment && currentSegment.words.length > 0) {
      segments.push({
        content: currentSegment.words.join(' '),
        speaker: 'spk_0',
        startMs: currentSegment.startMs,
        endMs: currentSegment.endMs
      });
    }
  }

  return { text: transcriptText, segments };
}

async function getMedicalTranscriptionJobStatus(
  jobName: string,
  accessKeyId: string,
  secretAccessKey: string,
  region: string
): Promise<{ status: string; transcriptUri?: string; failureReason?: string }> {
  const url = `https://transcribe.${region}.amazonaws.com`;
  
  const requestBody = JSON.stringify({
    MedicalTranscriptionJobName: jobName
  });

  const headers = await signRequest(
    'POST',
    url,
    {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': 'Transcribe.GetMedicalTranscriptionJob'
    },
    requestBody,
    'transcribe',
    region,
    accessKeyId,
    secretAccessKey
  );

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: requestBody,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Get medical job status failed: ${response.status} - ${errorText}`);
  }

  const result = await response.json();
  const job = result.MedicalTranscriptionJob;

  return {
    status: job.TranscriptionJobStatus,
    transcriptUri: job.Transcript?.TranscriptFileUri,
    failureReason: job.FailureReason
  };
}

async function verifyJWT(req: Request): Promise<{ userId: string } | null> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.replace('Bearer ', '');
  
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
  
  if (!supabaseUrl || !supabaseAnonKey) {
    console.error('Supabase env vars not configured');
    return null;
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false }
  });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  
  if (error || !user) {
    console.error('JWT verification failed:', error?.message);
    return null;
  }

  return { userId: user.id };
}

serve(async (req) => {
  const origin = req.headers.get('Origin');
  const corsHeaders = getCorsHeaders(origin);

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // Verify JWT
  const authResult = await verifyJWT(req);
  if (!authResult) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized: valid JWT required' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  try {
    const { jobName } = await req.json();
    
    if (!jobName) {
      return new Response(
        JSON.stringify({ error: 'jobName is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get validated AWS configuration
    const awsConfig = getAwsConfig();

    console.log(`[${authResult.userId}] Checking batch job status: ${jobName}`);

    const jobStatus = await getMedicalTranscriptionJobStatus(
      jobName,
      awsConfig.accessKeyId,
      awsConfig.secretAccessKey,
      awsConfig.region
    );

    console.log(`Job ${jobName} status: ${jobStatus.status}`);

    if (jobStatus.status === 'COMPLETED' && jobStatus.transcriptUri) {
      const transcriptResponse = await fetch(jobStatus.transcriptUri);
      const responseStatus = transcriptResponse.status;
      const responseStatusText = transcriptResponse.statusText;
      const contentType = transcriptResponse.headers.get('content-type') || '';
      const raw = await transcriptResponse.text();
      
      // Check if response is JSON
      const isJson = contentType.includes('application/json') || raw.trim().startsWith('{');
      
      if (!transcriptResponse.ok || !isJson) {
        // Return structured error for non-JSON or failed responses
        return new Response(
          JSON.stringify({ 
            ok: false,
            error: 'Non-JSON response from AWS/S3',
            status: responseStatus,
            statusText: responseStatusText,
            contentType,
            rawSnippet: raw.slice(0, 500),
            url: jobStatus.transcriptUri.replace(/\?.*$/, '?[REDACTED]') // Redact query params (contains signature)
          }),
          { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      const transcriptData = JSON.parse(raw);
      const parsed = parseTranscriptWithSpeakers(transcriptData);

      return new Response(
        JSON.stringify({ 
          status: 'COMPLETED',
          jobName,
          text: parsed.text,
          segments: parsed.segments
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    } else if (jobStatus.status === 'FAILED') {
      return new Response(
        JSON.stringify({ 
          status: 'FAILED',
          jobName,
          error: jobStatus.failureReason || 'Transcription job failed'
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    } else {
      return new Response(
        JSON.stringify({ 
          status: jobStatus.status,
          jobName
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

  } catch (error) {
    console.error('Error in transcribe-audio-batch-status:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
