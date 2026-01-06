import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { getCorsHeaders, getAwsConfig } from "../_shared/env.ts";

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
  mediaSampleRate: number,
  accessKeyId: string,
  secretAccessKey: string,
  region: string,
  languageCode: string
): Promise<void> {
  const url = `https://transcribe.${region}.amazonaws.com`;
  
  const requestBody: Record<string, unknown> = {
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
  };

  // Only set MediaSampleRateHertz for PCM - required for raw audio
  if (mediaFormat === 'wav' || mediaFormat === 'pcm') {
    requestBody.MediaSampleRateHertz = mediaSampleRate;
  }

  const headers = await signRequest(
    'POST',
    url,
    {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': 'Transcribe.StartMedicalTranscriptionJob'
    },
    JSON.stringify(requestBody),
    'transcribe',
    region,
    accessKeyId,
    secretAccessKey
  );

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody),
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

// Create WAV header for PCM data
function createWavHeader(dataLength: number, sampleRate: number, channels: number, bitsPerSample: number): Uint8Array {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  
  // RIFF header
  view.setUint8(0, 0x52); // R
  view.setUint8(1, 0x49); // I
  view.setUint8(2, 0x46); // F
  view.setUint8(3, 0x46); // F
  view.setUint32(4, 36 + dataLength, true); // File size - 8
  view.setUint8(8, 0x57);  // W
  view.setUint8(9, 0x41);  // A
  view.setUint8(10, 0x56); // V
  view.setUint8(11, 0x45); // E
  
  // fmt chunk
  view.setUint8(12, 0x66); // f
  view.setUint8(13, 0x6D); // m
  view.setUint8(14, 0x74); // t
  view.setUint8(15, 0x20); // (space)
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true); // AudioFormat (1 = PCM)
  view.setUint16(22, channels, true); // NumChannels
  view.setUint32(24, sampleRate, true); // SampleRate
  view.setUint32(28, byteRate, true); // ByteRate
  view.setUint16(32, blockAlign, true); // BlockAlign
  view.setUint16(34, bitsPerSample, true); // BitsPerSample
  
  // data chunk
  view.setUint8(36, 0x64); // d
  view.setUint8(37, 0x61); // a
  view.setUint8(38, 0x74); // t
  view.setUint8(39, 0x61); // a
  view.setUint32(40, dataLength, true); // Subchunk2Size
  
  return new Uint8Array(header);
}

interface TranscriptSegment {
  content: string;
  speaker: string;
  startMs: number;
  endMs: number;
}

function parseTranscriptWithSpeakers(transcriptData: Record<string, unknown>): { text: string; segments: TranscriptSegment[] } {
  const results = transcriptData.results as Record<string, unknown> | undefined;
  const transcripts = results?.transcripts as Array<{ transcript?: string }> | undefined;
  const transcriptText = transcripts?.[0]?.transcript || '';
  const segments: TranscriptSegment[] = [];

  const speakerLabels = results?.speaker_labels as Record<string, unknown> | undefined;
  const items = (results?.items || []) as Array<Record<string, unknown>>;

  if (speakerLabels?.segments) {
    const speakerSegments = speakerLabels.segments as Array<Record<string, unknown>>;
    for (const segment of speakerSegments) {
      const speaker = (segment.speaker_label as string) || 'spk_0';
      const startMs = Math.round(parseFloat((segment.start_time as string) || '0') * 1000);
      const endMs = Math.round(parseFloat((segment.end_time as string) || '0') * 1000);
      
      const segmentItems = (segment.items || []) as Array<Record<string, unknown>>;
      const words: string[] = [];
      
      for (const item of segmentItems) {
        const contentItem = items.find((ci) => 
          ci.start_time === item.start_time && ci.end_time === item.end_time
        );
        const alternatives = contentItem?.alternatives as Array<{ content?: string }> | undefined;
        if (alternatives?.[0]?.content) {
          words.push(alternatives[0].content);
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
        const alternatives = item.alternatives as Array<{ content?: string }> | undefined;
        const word = alternatives?.[0]?.content || '';
        const startMs = Math.round(parseFloat((item.start_time as string) || '0') * 1000);
        const endMs = Math.round(parseFloat((item.end_time as string) || '0') * 1000);
        
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
        const alternatives = item.alternatives as Array<{ content?: string }> | undefined;
        const lastWord = currentSegment.words.pop();
        if (lastWord) {
          currentSegment.words.push(lastWord + (alternatives?.[0]?.content || ''));
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

// Fetch transcript with signed URL (handles S3 output bucket permissions)
async function fetchTranscriptFromS3(
  bucket: string,
  key: string,
  accessKeyId: string,
  secretAccessKey: string,
  region: string
): Promise<string> {
  const url = `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
  
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
    throw new Error(`S3 fetch failed: ${response.status} - ${errorText}`);
  }

  return response.text();
}

serve(async (req) => {
  // Get CORS headers immediately - ensures headers exist on ALL responses
  const origin = req.headers.get('Origin');
  const corsHeaders = getCorsHeaders(origin);

  // Handle CORS preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    return new Response(null, { 
      status: 204, 
      headers: corsHeaders 
    });
  }

  // Wrap entire handler in try-catch to ensure CORS headers on ALL errors
  try {
    // Verify JWT
    const authResult = await verifyJWT(req);
    if (!authResult) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized: valid JWT required', code: 'AUTH_REQUIRED' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Parse request body
    let requestBody;
    try {
      requestBody = await req.json();
    } catch (parseError) {
      return new Response(
        JSON.stringify({ error: 'Invalid JSON in request body', code: 'INVALID_REQUEST' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { audio, encoding, sampleRate = 16000, languageCode = 'en-US', chunkIndex } = requestBody;
    
    if (!audio) {
      return new Response(
        JSON.stringify({ error: 'No audio data provided', code: 'MISSING_AUDIO' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get validated AWS configuration
    let awsConfig;
    try {
      awsConfig = getAwsConfig();
    } catch (configError) {
      console.error('AWS config error:', configError);
      return new Response(
        JSON.stringify({ error: 'Server configuration error', code: 'CONFIG_ERROR' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[${authResult.userId}] Processing live audio chunk ${chunkIndex ?? 'N/A'}, encoding: ${encoding}, sampleRate: ${sampleRate}...`);

    // Decode base64 audio
    const binaryString = atob(audio);
    const pcmData = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      pcmData[i] = binaryString.charCodeAt(i);
    }

    console.log(`Received ${pcmData.length} bytes of PCM data`);

    // Create WAV file from PCM data
    const wavHeader = createWavHeader(pcmData.length, sampleRate, 1, 16);
    const wavData = new Uint8Array(wavHeader.length + pcmData.length);
    wavData.set(wavHeader, 0);
    wavData.set(pcmData, wavHeader.length);

    console.log(`Created WAV file: ${wavData.length} bytes (header: ${wavHeader.length}, data: ${pcmData.length})`);

    const timestamp = Date.now();
    const chunkId = crypto.randomUUID().slice(0, 8);
    const jobName = `medical-live-${timestamp}-${chunkId}`;
    const s3Key = `${awsConfig.s3Prefix}live/${jobName}.wav`;

    console.log('Uploading WAV to S3...');
    await uploadToS3(
      wavData, awsConfig.s3Bucket, s3Key, 'audio/wav',
      awsConfig.accessKeyId, awsConfig.secretAccessKey, awsConfig.region
    );

    console.log('Starting medical transcription job:', jobName);
    await startMedicalTranscriptionJob(
      jobName, 
      `s3://${awsConfig.s3Bucket}/${s3Key}`, 
      awsConfig.s3Bucket, 
      awsConfig.s3Prefix, 
      'wav',
      sampleRate,
      awsConfig.accessKeyId, 
      awsConfig.secretAccessKey, 
      awsConfig.region, 
      languageCode
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
      
      if (jobStatus.status === 'COMPLETED') {
        // Fetch transcript using signed S3 request instead of presigned URL
        const outputKey = `${awsConfig.s3Prefix}live-output/${jobName}.json`;
        console.log(`Fetching transcript from S3: ${outputKey}`);
        
        try {
          const responseText = await fetchTranscriptFromS3(
            awsConfig.s3Bucket,
            outputKey,
            awsConfig.accessKeyId,
            awsConfig.secretAccessKey,
            awsConfig.region
          );
          
          const transcriptData = JSON.parse(responseText);
          const parsed = parseTranscriptWithSpeakers(transcriptData);
          transcriptText = parsed.text;
          segments = parsed.segments;
        } catch (fetchError) {
          console.error('Failed to fetch transcript from S3:', fetchError);
          return new Response(
            JSON.stringify({ 
              error: `Failed to fetch transcript: ${fetchError instanceof Error ? fetchError.message : 'Unknown error'}`,
              code: 'TRANSCRIPT_FETCH_ERROR'
            }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
        break;
      } else if (jobStatus.status === 'FAILED') {
        console.error('Medical transcription job failed:', jobStatus.failureReason);
        return new Response(
          JSON.stringify({ 
            error: `Transcription failed: ${jobStatus.failureReason}`,
            code: 'TRANSCRIPTION_FAILED'
          }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    try {
      await deleteMedicalTranscriptionJob(jobName, awsConfig.accessKeyId, awsConfig.secretAccessKey, awsConfig.region);
    } catch (cleanupError) {
      console.warn('Cleanup warning:', cleanupError);
    }

    console.log(`Live transcription completed: "${transcriptText.slice(0, 100)}", ${segments.length} segments`);

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
    // Catch-all error handler - ALWAYS includes CORS headers
    console.error('Error in transcribe-audio-live:', error);
    return new Response(
      JSON.stringify({ 
        error: error instanceof Error ? error.message : 'Unknown error',
        code: 'INTERNAL_ERROR'
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
