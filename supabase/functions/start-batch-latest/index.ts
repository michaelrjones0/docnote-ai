import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { getCorsHeaders, getAwsConfig } from "../_shared/env.ts";

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
      JSON.stringify({ ok: false, error: 'Unauthorized: valid JWT required' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  try {
    // Get validated AWS configuration
    const awsConfig = getAwsConfig();
    
    console.log(`[${authResult.userId}] Listing S3 objects in ${awsConfig.s3Bucket}/${awsConfig.s3Prefix}...`);

    // List objects in S3
    const objects = await listS3Objects(
      awsConfig.s3Bucket,
      awsConfig.s3Prefix,
      awsConfig.accessKeyId,
      awsConfig.secretAccessKey,
      awsConfig.region
    );

    console.log(`Found ${objects.length} total objects in S3`);

    // Filter for audio files only
    const audioFiles = objects.filter(obj => {
      const ext = obj.Key.split('.').pop()?.toLowerCase() || '';
      return AUDIO_EXTENSIONS.includes(ext);
    });

    console.log(`Found ${audioFiles.length} audio files`);

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
    
    console.log(`Most recent audio file: ${latestFile.Key} (${latestFile.LastModified})`);

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
    
    console.log(`Starting transcription job: ${jobName} for ${s3Uri}`);
    
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

    console.log(`Transcription job started successfully: ${jobName}`);

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
    console.error('Error in start-batch-latest:', error);
    return new Response(
      JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
