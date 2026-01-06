import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { getCorsHeaders, getAwsConfig } from "../_shared/env.ts";
import { requireUser, isAuthError } from "../_shared/auth.ts";
import { errorResponse } from "../_shared/response.ts";

// Supported audio formats
const AUDIO_EXTENSIONS = ['wav', 'mp3', 'm4a', 'webm', 'ogg', 'flac', 'mp4', 'amr'];

function getMediaFormatFromExtension(ext: string): string | null {
  const extToFormat: Record<string, string> = {
    'wav': 'wav',
    'mp3': 'mp3',
    'm4a': 'mp4',
    'webm': 'webm',
    'ogg': 'ogg',
    'flac': 'flac',
    'mp4': 'mp4',
    'amr': 'amr',
  };
  return extToFormat[ext.toLowerCase()] || null;
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

interface S3Object {
  Key: string;
  LastModified: string;
}

async function listS3Objects(
  bucket: string,
  prefix: string,
  accessKeyId: string,
  secretAccessKey: string,
  region: string
): Promise<S3Object[]> {
  const url = `https://${bucket}.s3.${region}.amazonaws.com/?list-type=2&prefix=${encodeURIComponent(prefix)}`;
  
  const headers = await signRequest(
    'GET',
    url,
    {},
    '',
    's3',
    region,
    accessKeyId,
    secretAccessKey
  );

  const response = await fetch(url, {
    method: 'GET',
    headers,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`S3 list failed: ${response.status} - ${errorText}`);
  }

  const xmlText = await response.text();
  
  // Parse XML to extract objects
  const objects: S3Object[] = [];
  const contentRegex = /<Contents>([\s\S]*?)<\/Contents>/g;
  let match;
  
  while ((match = contentRegex.exec(xmlText)) !== null) {
    const content = match[1];
    const keyMatch = content.match(/<Key>([^<]+)<\/Key>/);
    const lastModifiedMatch = content.match(/<LastModified>([^<]+)<\/LastModified>/);
    
    if (keyMatch && lastModifiedMatch) {
      objects.push({
        Key: keyMatch[1],
        LastModified: lastModifiedMatch[1],
      });
    }
  }
  
  return objects;
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


serve(async (req) => {
  const origin = req.headers.get('Origin');
  const { headers: corsHeaders, isAllowed: originAllowed } = getCorsHeaders(origin);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Block requests from disallowed origins
  if (!originAllowed) {
    console.warn('[start-batch-latest] Blocked disallowed origin');
    return new Response(
      JSON.stringify({ ok: false, error: 'Origin not allowed' }),
      { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // Verify JWT using shared auth helper
  const authResult = await requireUser(req, corsHeaders);
  if (isAuthError(authResult)) {
    return authResult.error;
  }

  try {
    // Get validated AWS configuration
    const awsConfig = getAwsConfig();
    
    // SECURITY: Do not log userId or S3 paths

    // List objects in S3
    const objects = await listS3Objects(
      awsConfig.s3Bucket,
      awsConfig.s3Prefix,
      awsConfig.accessKeyId,
      awsConfig.secretAccessKey,
      awsConfig.region
    );

    // SECURITY: Do not log object counts or file paths

    // Filter for audio files only
    const audioFiles = objects.filter(obj => {
      const ext = obj.Key.split('.').pop()?.toLowerCase() || '';
      return AUDIO_EXTENSIONS.includes(ext);
    });

    if (audioFiles.length === 0) {
      return new Response(
        JSON.stringify({ 
          ok: false, 
          error: `No audio files found under s3://${awsConfig.s3Bucket}/${awsConfig.s3Prefix}`,
          supportedFormats: AUDIO_EXTENSIONS
        }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Sort by LastModified descending and pick the most recent
    audioFiles.sort((a, b) => new Date(b.LastModified).getTime() - new Date(a.LastModified).getTime());
    const latestFile = audioFiles[0];
    
    // SECURITY: Do not log file paths

    // Get media format from extension
    const ext = latestFile.Key.split('.').pop()?.toLowerCase() || '';
    const mediaFormat = getMediaFormatFromExtension(ext);
    
    if (!mediaFormat) {
      return new Response(
        JSON.stringify({ ok: false, error: `Unsupported audio format: ${ext}` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Start transcription job
    const jobName = `batch-${Date.now()}`;
    const s3Uri = `s3://${awsConfig.s3Bucket}/${latestFile.Key}`;
    
    // SECURITY: Do not log S3 URIs or job names
    
    await startMedicalTranscriptionJob(
      jobName,
      s3Uri,
      mediaFormat,
      'en-US',
      awsConfig.s3Bucket,
      awsConfig.s3Prefix,
      awsConfig.accessKeyId,
      awsConfig.secretAccessKey,
      awsConfig.region
    );

    // SECURITY: Do not log job name

    return new Response(
      JSON.stringify({ 
        ok: true, 
        jobName, 
        s3Key: latestFile.Key,
        lastModified: latestFile.LastModified
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    // SECURITY: Do not log error details
    console.error('[start-batch-latest] Internal error');
    return new Response(
      JSON.stringify({ ok: false, error: 'An unexpected error occurred' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
