import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { getCorsHeaders, getAwsConfig } from "../_shared/env.ts";

// Supported formats for AWS Transcribe Medical
const SUPPORTED_FORMATS = ['mp3', 'mp4', 'wav', 'flac', 'ogg', 'amr', 'webm'];

function getMediaFormat(mimeType: string): string | null {
  const mimeToFormat: Record<string, string> = {
    'audio/webm': 'webm',
    'audio/webm;codecs=opus': 'webm',
    'audio/ogg': 'ogg',
    'audio/ogg;codecs=opus': 'ogg',
    'audio/mp3': 'mp3',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/flac': 'flac',
    'audio/mp4': 'mp4',
    'audio/amr': 'amr',
  };
  return mimeToFormat[mimeType.toLowerCase()] || null;
}

function processBase64Chunks(base64String: string, chunkSize = 32768): Uint8Array {
  const chunks: Uint8Array[] = [];
  let position = 0;
  
  while (position < base64String.length) {
    const chunk = base64String.slice(position, position + chunkSize);
    const binaryChunk = atob(chunk);
    const bytes = new Uint8Array(binaryChunk.length);
    
    for (let i = 0; i < binaryChunk.length; i++) {
      bytes[i] = binaryChunk.charCodeAt(i);
    }
    
    chunks.push(bytes);
    position += chunkSize;
  }

  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

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
  body: string | Uint8Array,
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
  
  const payloadHash = await sha256(typeof body === 'string' ? body : body);
  
  const signedHeaders: Record<string, string> = {
    ...headers,
    'host': host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
  };

  const sortedHeaderKeys = Object.keys(signedHeaders).sort();
  const canonicalHeaders = sortedHeaderKeys.map(k => `${k.toLowerCase()}:${signedHeaders[k].trim()}\n`).join('');
  const signedHeadersStr = sortedHeaderKeys.map(k => k.toLowerCase()).join(';');

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
    ...signedHeaders,
    'Authorization': authHeader,
  };
}

async function uploadToS3(
  data: Uint8Array,
  bucket: string,
  key: string,
  contentType: string,
  accessKeyId: string,
  secretAccessKey: string,
  region: string
): Promise<void> {
  const url = `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
  
  const headers = await signRequest(
    'PUT',
    url,
    { 
      'Content-Type': contentType,
      'x-amz-server-side-encryption': 'AES256'
    },
    data,
    's3',
    region,
    accessKeyId,
    secretAccessKey
  );

  const bodyBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  
  const response = await fetch(url, {
    method: 'PUT',
    headers,
    body: bodyBuffer,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`S3 upload failed: ${response.status} - ${errorText}`);
  }
}

async function startMedicalTranscriptionJob(
  jobName: string,
  s3Uri: string,
  mediaFormat: string,
  languageCode: string,
  outputBucket: string,
  outputPrefix: string,
  accessKeyId: string,
  secretAccessKey: string,
  region: string
): Promise<void> {
  const url = `https://transcribe.${region}.amazonaws.com`;
  
  const requestBody = JSON.stringify({
    MedicalTranscriptionJobName: jobName,
    LanguageCode: languageCode,
    MediaFormat: mediaFormat,
    Media: {
      MediaFileUri: s3Uri
    },
    OutputBucketName: outputBucket,
    OutputKey: `${outputPrefix}batch-output/${jobName}.json`,
    Specialty: 'PRIMARYCARE',
    Type: 'CONVERSATION',
    Settings: {
      ShowSpeakerLabels: true,
      MaxSpeakerLabels: 2,
      ChannelIdentification: false
    }
  });

  const headers = await signRequest(
    'POST',
    url,
    {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': 'Transcribe.StartMedicalTranscriptionJob'
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
    throw new Error(`Medical transcribe job start failed: ${response.status} - ${errorText}`);
  }
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
    const { audio, encounterId, languageCode = 'en-US', mimeType = 'audio/webm' } = await req.json();
    
    if (!audio) {
      throw new Error('No audio data provided');
    }

    // Validate audio format
    const mediaFormat = getMediaFormat(mimeType);
    if (!mediaFormat) {
      return new Response(
        JSON.stringify({ 
          error: `Unsupported audio format: ${mimeType}. Supported formats: ${SUPPORTED_FORMATS.join(', ')}`,
          receivedFormat: mimeType,
          supportedFormats: SUPPORTED_FORMATS
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get validated AWS configuration
    const awsConfig = getAwsConfig();

    console.log(`[${authResult.userId}] Starting batch medical transcription (${mimeType})...`);

    const binaryAudio = processBase64Chunks(audio);
    
    const timestamp = Date.now();
    const fileExtension = mediaFormat;
    const audioKey = `${awsConfig.s3Prefix}batch/${encounterId || 'unknown'}/${timestamp}-audio.${fileExtension}`;
    
    console.log(`Uploading audio to S3 with encryption: ${audioKey}`);
    await uploadToS3(
      binaryAudio,
      awsConfig.s3Bucket,
      audioKey,
      mimeType,
      awsConfig.accessKeyId,
      awsConfig.secretAccessKey,
      awsConfig.region
    );
    console.log('Audio uploaded to S3 successfully');

    const jobName = `medical-batch-${encounterId || 'unknown'}-${timestamp}`;
    const s3Uri = `s3://${awsConfig.s3Bucket}/${audioKey}`;
    
    console.log(`Starting medical transcription job: ${jobName}`);
    await startMedicalTranscriptionJob(
      jobName,
      s3Uri,
      mediaFormat,
      languageCode,
      awsConfig.s3Bucket,
      awsConfig.s3Prefix,
      awsConfig.accessKeyId,
      awsConfig.secretAccessKey,
      awsConfig.region
    );
    console.log('Medical transcription job started - returning jobName for async polling');

    // Return immediately with jobName - client should poll transcribe-audio-batch-status
    return new Response(
      JSON.stringify({ 
        jobName,
        status: 'IN_PROGRESS',
        message: 'Transcription job started. Poll transcribe-audio-batch-status for results.'
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in transcribe-audio-batch:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
