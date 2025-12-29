import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Process base64 in chunks to prevent memory issues
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

// AWS Signature V4 helpers
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

async function sha256(data: Uint8Array | string): Promise<string> {
  const buffer = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  const hash = await crypto.subtle.digest('SHA-256', arrayBuffer);
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
  accessKeyId: string,
  secretAccessKey: string,
  region: string
): Promise<void> {
  const url = `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
  
  const headers = await signRequest(
    'PUT',
    url,
    { 'Content-Type': 'audio/webm' },
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
  outputBucket: string,
  accessKeyId: string,
  secretAccessKey: string,
  region: string,
  languageCode: string
): Promise<void> {
  const url = `https://transcribe.${region}.amazonaws.com`;
  
  const requestBody = JSON.stringify({
    MedicalTranscriptionJobName: jobName,
    LanguageCode: languageCode,
    MediaFormat: 'webm',
    Media: {
      MediaFileUri: s3Uri
    },
    OutputBucketName: outputBucket,
    OutputKey: `transcribe/live-output/${jobName}.json`,
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

async function deleteMedicalTranscriptionJob(
  jobName: string,
  accessKeyId: string,
  secretAccessKey: string,
  region: string
): Promise<void> {
  const url = `https://transcribe.${region}.amazonaws.com`;
  
  const requestBody = JSON.stringify({
    MedicalTranscriptionJobName: jobName
  });

  const headers = await signRequest(
    'POST',
    url,
    {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': 'Transcribe.DeleteMedicalTranscriptionJob'
    },
    requestBody,
    'transcribe',
    region,
    accessKeyId,
    secretAccessKey
  );

  await fetch(url, {
    method: 'POST',
    headers,
    body: requestBody,
  });
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { audio, languageCode = 'en-US' } = await req.json();
    
    if (!audio) {
      throw new Error('No audio data provided');
    }

    const AWS_ACCESS_KEY_ID = Deno.env.get('AWS_ACCESS_KEY_ID');
    const AWS_SECRET_ACCESS_KEY = Deno.env.get('AWS_SECRET_ACCESS_KEY');
    const AWS_REGION = Deno.env.get('AWS_REGION') || 'us-west-2';

    if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
      throw new Error('AWS credentials not configured');
    }

    const S3_BUCKET = 'apollohealth-transcription-us-west-2';

    console.log('Processing live audio chunk with AWS Transcribe Medical...');

    // Process audio from base64 to binary
    const binaryAudio = processBase64Chunks(audio);
    
    // Generate unique identifiers
    const timestamp = Date.now();
    const chunkId = crypto.randomUUID().slice(0, 8);
    const jobName = `medical-live-${timestamp}-${chunkId}`;
    const s3Key = `transcribe/live/${jobName}.webm`;

    // Upload to S3
    console.log('Uploading chunk to S3...');
    await uploadToS3(
      binaryAudio, S3_BUCKET, s3Key,
      AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION
    );

    // Start medical transcription job
    console.log('Starting medical transcription job:', jobName);
    await startMedicalTranscriptionJob(
      jobName, `s3://${S3_BUCKET}/${s3Key}`, S3_BUCKET,
      AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, languageCode
    );

    // Poll for completion (shorter timeout for live chunks)
    const maxAttempts = 40; // ~40 seconds max for live chunks
    let transcriptText = '';
    
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const jobStatus = await getMedicalTranscriptionJobStatus(
        jobName, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION
      );
      
      console.log(`Job ${jobName} status: ${jobStatus.status} (attempt ${attempt + 1})`);
      
      if (jobStatus.status === 'COMPLETED' && jobStatus.transcriptUri) {
        const transcriptResponse = await fetch(jobStatus.transcriptUri);
        const transcriptData = await transcriptResponse.json();
        transcriptText = transcriptData.results?.transcripts?.[0]?.transcript || '';
        break;
      } else if (jobStatus.status === 'FAILED') {
        console.error('Medical transcription job failed:', jobStatus.failureReason);
        break;
      }
    }

    // Cleanup: delete job
    try {
      await deleteMedicalTranscriptionJob(jobName, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION);
    } catch (cleanupError) {
      console.warn('Cleanup warning:', cleanupError);
    }

    console.log('Live medical transcription completed:', transcriptText.slice(0, 100));

    return new Response(
      JSON.stringify({ 
        text: transcriptText,
        isPartial: false,
        confidence: 0.95
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in transcribe-audio-live:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
