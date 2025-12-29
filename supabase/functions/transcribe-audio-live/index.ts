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

async function createAWSSignature(
  method: string,
  service: string,
  region: string,
  host: string,
  path: string,
  queryString: string,
  headers: Record<string, string>,
  payloadHash: string,
  accessKeyId: string,
  secretAccessKey: string,
  amzDate: string,
  dateStamp: string
): Promise<string> {
  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  
  const sortedHeaders = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaders.map(k => `${k.toLowerCase()}:${headers[k].trim()}\n`).join('');
  const signedHeaders = sortedHeaders.map(k => k.toLowerCase()).join(';');
  
  const canonicalRequest = [
    method,
    path,
    queryString,
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
  
  const kDate = await hmacSHA256(new TextEncoder().encode('AWS4' + secretAccessKey), dateStamp);
  const kRegion = await hmacSHA256(kDate, region);
  const kService = await hmacSHA256(kRegion, service);
  const kSigning = await hmacSHA256(kService, 'aws4_request');
  
  const signatureBytes = await hmacSHA256(kSigning, stringToSign);
  const signature = Array.from(new Uint8Array(signatureBytes)).map(b => b.toString(16).padStart(2, '0')).join('');
  
  return `${algorithm} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

// Upload audio to S3
async function uploadToS3(
  audioData: Uint8Array,
  bucket: string,
  key: string,
  accessKeyId: string,
  secretAccessKey: string,
  region: string
): Promise<string> {
  const host = `${bucket}.s3.${region}.amazonaws.com`;
  const path = `/${key}`;
  
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  
  const payloadHash = await sha256(audioData);
  
  const headers: Record<string, string> = {
    'Host': host,
    'Content-Type': 'audio/webm',
    'X-Amz-Content-Sha256': payloadHash,
    'X-Amz-Date': amzDate,
  };
  
  const authHeader = await createAWSSignature(
    'PUT', 's3', region, host, path, '',
    headers, payloadHash, accessKeyId, secretAccessKey, amzDate, dateStamp
  );
  
  headers['Authorization'] = authHeader;
  
  const bodyBuffer = audioData.buffer.slice(audioData.byteOffset, audioData.byteOffset + audioData.byteLength) as ArrayBuffer;
  
  const response = await fetch(`https://${host}${path}`, {
    method: 'PUT',
    headers,
    body: bodyBuffer,
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`S3 upload failed: ${response.status} - ${errorText}`);
  }
  
  return `s3://${bucket}/${key}`;
}

// Start AWS Transcribe job
async function startTranscribeJob(
  jobName: string,
  s3Uri: string,
  accessKeyId: string,
  secretAccessKey: string,
  region: string,
  languageCode: string
): Promise<void> {
  const host = `transcribe.${region}.amazonaws.com`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  
  const requestBody = JSON.stringify({
    TranscriptionJobName: jobName,
    LanguageCode: languageCode,
    MediaFormat: 'webm',
    Media: { MediaFileUri: s3Uri },
    Settings: { ShowSpeakerLabels: false }
  });
  
  const payloadHash = await sha256(requestBody);
  
  const headers: Record<string, string> = {
    'Host': host,
    'Content-Type': 'application/x-amz-json-1.1',
    'X-Amz-Target': 'Transcribe.StartTranscriptionJob',
    'X-Amz-Content-Sha256': payloadHash,
    'X-Amz-Date': amzDate,
  };
  
  const authHeader = await createAWSSignature(
    'POST', 'transcribe', region, host, '/', '',
    headers, payloadHash, accessKeyId, secretAccessKey, amzDate, dateStamp
  );
  
  headers['Authorization'] = authHeader;
  
  const response = await fetch(`https://${host}/`, {
    method: 'POST',
    headers,
    body: requestBody,
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`StartTranscriptionJob failed: ${response.status} - ${errorText}`);
  }
}

// Get Transcribe job result
async function getTranscribeJob(
  jobName: string,
  accessKeyId: string,
  secretAccessKey: string,
  region: string
): Promise<{ status: string; transcriptUri?: string }> {
  const host = `transcribe.${region}.amazonaws.com`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  
  const requestBody = JSON.stringify({ TranscriptionJobName: jobName });
  const payloadHash = await sha256(requestBody);
  
  const headers: Record<string, string> = {
    'Host': host,
    'Content-Type': 'application/x-amz-json-1.1',
    'X-Amz-Target': 'Transcribe.GetTranscriptionJob',
    'X-Amz-Content-Sha256': payloadHash,
    'X-Amz-Date': amzDate,
  };
  
  const authHeader = await createAWSSignature(
    'POST', 'transcribe', region, host, '/', '',
    headers, payloadHash, accessKeyId, secretAccessKey, amzDate, dateStamp
  );
  
  headers['Authorization'] = authHeader;
  
  const response = await fetch(`https://${host}/`, {
    method: 'POST',
    headers,
    body: requestBody,
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GetTranscriptionJob failed: ${response.status} - ${errorText}`);
  }
  
  const data = await response.json();
  return {
    status: data.TranscriptionJob?.TranscriptionJobStatus || 'UNKNOWN',
    transcriptUri: data.TranscriptionJob?.Transcript?.TranscriptFileUri
  };
}

// Delete Transcribe job
async function deleteTranscribeJob(
  jobName: string,
  accessKeyId: string,
  secretAccessKey: string,
  region: string
): Promise<void> {
  const host = `transcribe.${region}.amazonaws.com`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  
  const requestBody = JSON.stringify({ TranscriptionJobName: jobName });
  const payloadHash = await sha256(requestBody);
  
  const headers: Record<string, string> = {
    'Host': host,
    'Content-Type': 'application/x-amz-json-1.1',
    'X-Amz-Target': 'Transcribe.DeleteTranscriptionJob',
    'X-Amz-Content-Sha256': payloadHash,
    'X-Amz-Date': amzDate,
  };
  
  const authHeader = await createAWSSignature(
    'POST', 'transcribe', region, host, '/', '',
    headers, payloadHash, accessKeyId, secretAccessKey, amzDate, dateStamp
  );
  
  headers['Authorization'] = authHeader;
  
  await fetch(`https://${host}/`, {
    method: 'POST',
    headers,
    body: requestBody,
  });
}

// Delete S3 object
async function deleteFromS3(
  bucket: string,
  key: string,
  accessKeyId: string,
  secretAccessKey: string,
  region: string
): Promise<void> {
  const host = `${bucket}.s3.${region}.amazonaws.com`;
  const path = `/${key}`;
  
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  
  const payloadHash = await sha256(new Uint8Array(0));
  
  const headers: Record<string, string> = {
    'Host': host,
    'X-Amz-Content-Sha256': payloadHash,
    'X-Amz-Date': amzDate,
  };
  
  const authHeader = await createAWSSignature(
    'DELETE', 's3', region, host, path, '',
    headers, payloadHash, accessKeyId, secretAccessKey, amzDate, dateStamp
  );
  
  headers['Authorization'] = authHeader;
  
  await fetch(`https://${host}${path}`, {
    method: 'DELETE',
    headers,
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
    const AWS_REGION = Deno.env.get('AWS_REGION') || 'us-east-1';
    const AWS_S3_BUCKET = Deno.env.get('AWS_S3_BUCKET');

    if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
      throw new Error('AWS credentials not configured');
    }

    if (!AWS_S3_BUCKET) {
      throw new Error('AWS S3 bucket not configured');
    }

    console.log('Processing live audio chunk with AWS Transcribe...');

    // Process audio from base64 to binary
    const binaryAudio = processBase64Chunks(audio);
    
    // Generate unique identifiers
    const timestamp = Date.now();
    const chunkId = crypto.randomUUID().slice(0, 8);
    const jobName = `live-${timestamp}-${chunkId}`;
    const s3Key = `live-chunks/${jobName}.webm`;

    // Upload to S3
    console.log('Uploading chunk to S3...');
    const s3Uri = await uploadToS3(
      binaryAudio, AWS_S3_BUCKET, s3Key,
      AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION
    );

    // Start transcription job
    console.log('Starting transcription job:', jobName);
    await startTranscribeJob(
      jobName, s3Uri,
      AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, languageCode
    );

    // Poll for completion (with timeout for live chunks - shorter than batch)
    const maxAttempts = 30; // ~30 seconds max for live chunks
    let transcriptText = '';
    
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const jobStatus = await getTranscribeJob(
        jobName, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION
      );
      
      console.log(`Job ${jobName} status: ${jobStatus.status} (attempt ${attempt + 1})`);
      
      if (jobStatus.status === 'COMPLETED' && jobStatus.transcriptUri) {
        const transcriptResponse = await fetch(jobStatus.transcriptUri);
        const transcriptData = await transcriptResponse.json();
        transcriptText = transcriptData.results?.transcripts?.[0]?.transcript || '';
        break;
      } else if (jobStatus.status === 'FAILED') {
        console.error('Transcription job failed');
        break;
      }
    }

    // Cleanup: delete job and S3 object
    try {
      await deleteTranscribeJob(jobName, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION);
      await deleteFromS3(s3Key.split('/').pop()!, AWS_S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION);
    } catch (cleanupError) {
      console.warn('Cleanup warning:', cleanupError);
    }

    console.log('Live transcription completed:', transcriptText.slice(0, 100));

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
