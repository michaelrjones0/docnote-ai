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
  
  // Include server-side encryption header
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
  outputBucket: string,
  outputPrefix: string,
  mediaFormat: string,
  accessKeyId: string,
  secretAccessKey: string,
  region: string,
  languageCode: string
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
    OutputKey: `${outputPrefix}live-output/${jobName}.json`,
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
    const { audio, languageCode = 'en-US', chunkIndex, mimeType = 'audio/webm' } = await req.json();
    
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

    console.log(`[${authResult.userId}] Processing live audio chunk ${chunkIndex ?? 'N/A'} (${mimeType}) with AWS Transcribe Medical...`);

    const binaryAudio = processBase64Chunks(audio);
    
    const timestamp = Date.now();
    const chunkId = crypto.randomUUID().slice(0, 8);
    const jobName = `medical-live-${timestamp}-${chunkId}`;
    const fileExtension = mediaFormat;
    const s3Key = `${awsConfig.s3Prefix}live/${jobName}.${fileExtension}`;

    console.log('Uploading chunk to S3 with encryption...');
    await uploadToS3(
      binaryAudio, awsConfig.s3Bucket, s3Key, mimeType,
      awsConfig.accessKeyId, awsConfig.secretAccessKey, awsConfig.region
    );

    console.log('Starting medical transcription job:', jobName);
    await startMedicalTranscriptionJob(
      jobName, `s3://${awsConfig.s3Bucket}/${s3Key}`, awsConfig.s3Bucket, awsConfig.s3Prefix, mediaFormat,
      awsConfig.accessKeyId, awsConfig.secretAccessKey, awsConfig.region, languageCode
    );

    const maxAttempts = 60;
    let transcriptText = '';
    let segments: TranscriptSegment[] = [];
    
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const jobStatus = await getMedicalTranscriptionJobStatus(
        jobName, awsConfig.accessKeyId, awsConfig.secretAccessKey, awsConfig.region
      );
      
      console.log(`Job ${jobName} status: ${jobStatus.status} (attempt ${attempt + 1})`);
      
      if (jobStatus.status === 'COMPLETED' && jobStatus.transcriptUri) {
        console.log(`Fetching transcript from: ${jobStatus.transcriptUri}`);
        const transcriptResponse = await fetch(jobStatus.transcriptUri);
        const responseText = await transcriptResponse.text();
        
        // Check if response is XML (error from S3) instead of JSON
        if (responseText.startsWith('<?xml') || responseText.startsWith('<')) {
          console.error('Received XML error response from transcript URI:', responseText.slice(0, 500));
          throw new Error('Failed to fetch transcript: S3 returned XML error (check bucket permissions or presigned URL)');
        }
        
        try {
          const transcriptData = JSON.parse(responseText);
          const parsed = parseTranscriptWithSpeakers(transcriptData);
          transcriptText = parsed.text;
          segments = parsed.segments;
        } catch (parseError) {
          console.error('Failed to parse transcript JSON:', responseText.slice(0, 500));
          throw new Error(`Failed to parse transcript: ${parseError instanceof Error ? parseError.message : 'Invalid JSON'}`);
        }
        break;
      } else if (jobStatus.status === 'FAILED') {
        console.error('Medical transcription job failed:', jobStatus.failureReason);
        throw new Error(`Transcription failed: ${jobStatus.failureReason}`);
      }
    }

    try {
      await deleteMedicalTranscriptionJob(jobName, awsConfig.accessKeyId, awsConfig.secretAccessKey, awsConfig.region);
    } catch (cleanupError) {
      console.warn('Cleanup warning:', cleanupError);
    }

    console.log(`Live medical transcription completed: ${transcriptText.slice(0, 100)}, ${segments.length} segments`);

    return new Response(
      JSON.stringify({ 
        text: transcriptText,
        segments,
        chunkIndex,
        isPartial: false
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in transcribe-audio-live:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
