import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { getCorsHeaders, getAwsConfig } from "../_shared/env.ts";
import { requireUser, isAuthError } from "../_shared/auth.ts";

/**
 * transcribe-stream-start
 * 
 * Returns a pre-signed WebSocket URL for AWS Transcribe Medical Streaming.
 * The client connects directly to AWS and streams PCM audio frames.
 * 
 * PHI-safe: No audio or transcript content is logged.
 */

async function hmacSHA256(key: ArrayBuffer | Uint8Array, message: string): Promise<ArrayBuffer> {
  let keyBuffer: ArrayBuffer;
  if (key instanceof Uint8Array) {
    keyBuffer = key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer;
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

async function sha256(data: string): Promise<string> {
  const buffer = new TextEncoder().encode(data);
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function createPresignedUrl(
  accessKeyId: string,
  secretAccessKey: string,
  region: string,
  languageCode: string,
  sampleRate: number,
  specialty: string = 'PRIMARYCARE',
  sessionToken?: string
): Promise<string> {
  const service = 'transcribe';
  const host = `transcribestreaming.${region}.amazonaws.com`;
  const endpoint = `wss://${host}:8443/medical-stream-transcription-websocket`;
  
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  
  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const credential = `${accessKeyId}/${credentialScope}`;
  
  // Generate unique session ID (required by AWS)
  const sessionId = crypto.randomUUID();
  
  // Query parameters for AWS Transcribe Medical Streaming
  const queryParams: Record<string, string> = {
    'language-code': languageCode,
    'media-encoding': 'pcm',
    'sample-rate': sampleRate.toString(),
    'session-id': sessionId,
    'specialty': specialty,
    'type': 'DICTATION',
    'show-speaker-label': 'false',
    'partial-results-stability': 'high',
  };
  
  // Add signature query params
  const signatureParams: Record<string, string> = {
    'X-Amz-Algorithm': algorithm,
    'X-Amz-Credential': credential,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': '300',
    'X-Amz-SignedHeaders': 'host',
  };
  
  // Add security token if using temporary credentials
  if (sessionToken) {
    signatureParams['X-Amz-Security-Token'] = sessionToken;
  }
  
  const allParams = { ...queryParams, ...signatureParams };
  const sortedKeys = Object.keys(allParams).sort();
  const canonicalQueryString = sortedKeys
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(allParams[k])}`)
    .join('&');
  
  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders = 'host';
  const payloadHash = await sha256('');
  
  const canonicalRequest = [
    'GET',
    '/medical-stream-transcription-websocket',
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');
  
  const canonicalRequestHash = await sha256(canonicalRequest);
  
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    canonicalRequestHash
  ].join('\n');
  
  // Create signing key
  const kDate = await hmacSHA256(new TextEncoder().encode('AWS4' + secretAccessKey), dateStamp);
  const kRegion = await hmacSHA256(kDate, region);
  const kService = await hmacSHA256(kRegion, service);
  const kSigning = await hmacSHA256(kService, 'aws4_request');
  
  const signatureBytes = await hmacSHA256(kSigning, stringToSign);
  const signature = toHex(signatureBytes);
  
  return `${endpoint}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
}

serve(async (req) => {
  const origin = req.headers.get('Origin');
  const { headers: corsHeaders, isAllowed: originAllowed } = getCorsHeaders(origin);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (!originAllowed) {
    console.warn(`Blocked request from disallowed origin: ${origin}`);
    return new Response(
      JSON.stringify({ error: 'Origin not allowed', code: 'CORS_BLOCKED' }),
      { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  try {
    const authResult = await requireUser(req, corsHeaders);
    if (isAuthError(authResult)) {
      return authResult.error;
    }

    let requestBody;
    try {
      requestBody = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ error: 'Invalid JSON in request body', code: 'INVALID_REQUEST' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { 
      languageCode = 'en-US', 
      sampleRate = 16000,
      specialty = 'PRIMARYCARE'
    } = requestBody;

    const awsConfig = getAwsConfig();
    
    if (!awsConfig.accessKeyId || !awsConfig.secretAccessKey) {
      console.error('AWS credentials not configured');
      return new Response(
        JSON.stringify({ error: 'AWS credentials not configured', code: 'CONFIG_ERROR' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check for session token (temporary credentials)
    const sessionToken = Deno.env.get('AWS_SESSION_TOKEN');

    const presignedUrl = await createPresignedUrl(
      awsConfig.accessKeyId,
      awsConfig.secretAccessKey,
      awsConfig.region,
      languageCode,
      sampleRate,
      specialty,
      sessionToken
    );

    console.log('Generated presigned streaming URL', { 
      region: awsConfig.region, 
      languageCode, 
      sampleRate 
    });

    return new Response(
      JSON.stringify({ 
        url: presignedUrl,
        sampleRate,
        encoding: 'pcm',
        languageCode,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error generating presigned URL:', error);
    return new Response(
      JSON.stringify({ error: 'Failed to generate streaming URL', code: 'INTERNAL_ERROR' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
