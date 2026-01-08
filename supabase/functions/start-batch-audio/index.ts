/**
 * start-batch-audio: Accept WAV audio directly and start AWS Medical Transcription batch job
 * 
 * This endpoint receives audio content from the client and:
 * 1. Uploads it to S3
 * 2. Starts an AWS Transcribe Medical batch job
 * 3. Returns the jobName for status polling
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireUser, isAuthError } from "../_shared/auth.ts";
import { getCorsHeaders, getAwsConfig } from "../_shared/env.ts";
import { jsonResponse, errorResponse } from "../_shared/response.ts";

// =====================================================
// AWS Signing Utilities
// =====================================================

async function hmacSHA256(key: ArrayBuffer | Uint8Array, message: string): Promise<ArrayBuffer> {
  const keyBuffer = key instanceof Uint8Array ? key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) : key;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBuffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
}

async function sha256(message: string | Uint8Array): Promise<string> {
  let buffer: ArrayBuffer;
  if (typeof message === 'string') {
    buffer = new TextEncoder().encode(message).buffer as ArrayBuffer;
  } else {
    // Copy to a new ArrayBuffer to ensure it's not SharedArrayBuffer
    const copy = new Uint8Array(message.length);
    copy.set(message);
    buffer = copy.buffer as ArrayBuffer;
  }
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

async function getSignatureKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string
): Promise<ArrayBuffer> {
  const kDate = await hmacSHA256(new TextEncoder().encode("AWS4" + secretKey), dateStamp);
  const kRegion = await hmacSHA256(kDate, region);
  const kService = await hmacSHA256(kRegion, service);
  const kSigning = await hmacSHA256(kService, "aws4_request");
  return kSigning;
}

async function signRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: Uint8Array,
  accessKeyId: string,
  secretAccessKey: string,
  region: string,
  service: string
): Promise<Record<string, string>> {
  const urlObj = new URL(url);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:\-]|\.\d{3}/g, "").substring(0, 15) + "Z";
  const dateStamp = amzDate.substring(0, 8);

  // Normalize headers to lowercase
  const normalizedHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalizedHeaders[key.toLowerCase()] = value;
  }
  normalizedHeaders["x-amz-date"] = amzDate;

  // Calculate payload hash from binary body
  const payloadHash = await sha256(body);
  normalizedHeaders["x-amz-content-sha256"] = payloadHash;

  // Build canonical request
  const sortedHeaderKeys = Object.keys(normalizedHeaders).sort();
  const canonicalHeaders = sortedHeaderKeys.map(k => `${k}:${normalizedHeaders[k]}`).join("\n") + "\n";
  const signedHeaders = sortedHeaderKeys.join(";");

  const canonicalRequest = [
    method,
    urlObj.pathname,
    urlObj.search.substring(1),
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join("\n");

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256(canonicalRequest)
  ].join("\n");

  const signingKey = await getSignatureKey(secretAccessKey, dateStamp, region, service);
  const signatureBuffer = await hmacSHA256(signingKey, stringToSign);
  const signature = Array.from(new Uint8Array(signatureBuffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    ...normalizedHeaders,
    "authorization": authHeader,
  };
}

// =====================================================
// S3 Upload
// =====================================================

async function uploadToS3(
  bucket: string,
  key: string,
  body: Uint8Array,
  contentType: string,
  awsConfig: ReturnType<typeof getAwsConfig>
): Promise<void> {
  const url = `https://${bucket}.s3.${awsConfig.region}.amazonaws.com/${key}`;
  
  const headers: Record<string, string> = {
    "host": `${bucket}.s3.${awsConfig.region}.amazonaws.com`,
    "content-type": contentType,
    "content-length": body.byteLength.toString(),
    "x-amz-server-side-encryption": "AES256",
  };

  const signedHeaders = await signRequest(
    "PUT",
    url,
    headers,
    body,
    awsConfig.accessKeyId,
    awsConfig.secretAccessKey,
    awsConfig.region,
    "s3"
  );

  // Copy to ensure it's a proper ArrayBuffer for fetch body
  const bodyCopy = new Uint8Array(body.length);
  bodyCopy.set(body);
  
  const response = await fetch(url, {
    method: "PUT",
    headers: signedHeaders,
    body: bodyCopy.buffer as ArrayBuffer,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`S3 upload failed: ${response.status} - ${errorText.substring(0, 200)}`);
  }
}

// =====================================================
// AWS Transcribe Medical
// =====================================================

async function startMedicalTranscriptionJob(
  jobName: string,
  mediaUri: string,
  outputBucket: string,
  outputKey: string,
  awsConfig: ReturnType<typeof getAwsConfig>
): Promise<{ ok: boolean; jobName: string }> {
  const transcribeEndpoint = `https://transcribe.${awsConfig.region}.amazonaws.com`;
  
  const requestBody = {
    MedicalTranscriptionJobName: jobName,
    LanguageCode: "en-US",
    Media: {
      MediaFileUri: mediaUri,
    },
    MediaFormat: "wav",
    OutputBucketName: outputBucket,
    OutputKey: outputKey,
    Specialty: "PRIMARYCARE",
    Type: "CONVERSATION",
    Settings: {
      ShowSpeakerLabels: true,
      MaxSpeakerLabels: 2,
    },
  };

  const bodyBytes = new TextEncoder().encode(JSON.stringify(requestBody));
  
  const headers: Record<string, string> = {
    "host": `transcribe.${awsConfig.region}.amazonaws.com`,
    "content-type": "application/x-amz-json-1.1",
    "x-amz-target": "Transcribe.StartMedicalTranscriptionJob",
  };

  const signedHeaders = await signRequest(
    "POST",
    transcribeEndpoint,
    headers,
    bodyBytes,
    awsConfig.accessKeyId,
    awsConfig.secretAccessKey,
    awsConfig.region,
    "transcribe"
  );

  // Copy to ensure it's a proper ArrayBuffer for fetch body
  const bodyCopy = new Uint8Array(bodyBytes.length);
  bodyCopy.set(bodyBytes);
  
  const response = await fetch(transcribeEndpoint, {
    method: "POST",
    headers: signedHeaders,
    body: bodyCopy.buffer as ArrayBuffer,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Transcribe API error: ${response.status} - ${errorText.substring(0, 300)}`);
  }

  return { ok: true, jobName };
}

// =====================================================
// Main Handler
// =====================================================

serve(async (req) => {
  const requestStartTime = Date.now();
  const origin = req.headers.get("origin");
  const { headers: corsHeaders, isAllowed } = getCorsHeaders(origin);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Reject disallowed origins
  if (!isAllowed) {
    return errorResponse("Origin not allowed", 403, corsHeaders);
  }

  // Timing instrumentation
  const timings: Record<string, number> = {};

  try {
    // Authenticate user
    const authResult = await requireUser(req, corsHeaders);
    if (isAuthError(authResult)) {
      return authResult.error;
    }
    const userId = authResult.userId;

    // Parse request body
    const decodeStartTime = Date.now();
    const body = await req.json();
    const { audioBase64, mimeType } = body;

    if (!audioBase64 || typeof audioBase64 !== 'string') {
      return errorResponse("Missing or invalid audioBase64", 400, corsHeaders);
    }

    if (mimeType !== 'audio/wav') {
      return errorResponse("Only audio/wav is supported", 400, corsHeaders);
    }

    // Decode base64 to binary
    const audioBytes = Uint8Array.from(atob(audioBase64), c => c.charCodeAt(0));
    timings.decodeMs = Date.now() - decodeStartTime;
    
    // PHI-safe logging: only sizes, no content
    console.log("[start-batch-audio] Received audio:", {
      bytes: audioBytes.byteLength,
      mimeType,
      userId: userId.substring(0, 8) + "...",
    });

    // Validate minimum size (20KB)
    const MIN_AUDIO_BYTES = 20_000;
    if (audioBytes.byteLength < MIN_AUDIO_BYTES) {
      return errorResponse(
        `Audio too small: ${audioBytes.byteLength} bytes (minimum ${MIN_AUDIO_BYTES})`,
        400,
        corsHeaders
      );
    }

    // Validate WAV header
    const riffHeader = new TextDecoder().decode(audioBytes.slice(0, 4));
    const waveHeader = new TextDecoder().decode(audioBytes.slice(8, 12));
    if (riffHeader !== 'RIFF' || waveHeader !== 'WAVE') {
      return errorResponse("Invalid WAV file format", 400, corsHeaders);
    }

    // Estimate audio duration from WAV header (bytes / (sample_rate * channels * bytes_per_sample))
    // Assumes 16kHz, mono, 16-bit = 32000 bytes/sec
    const estimatedDurationMs = Math.round((audioBytes.byteLength - 44) / 32 * 1000 / 1000);

    // Get AWS config
    const awsConfig = getAwsConfig();

    // Generate unique job name and S3 key
    const timestamp = Date.now();
    const jobName = `batch-${timestamp}`;
    const s3Key = `${awsConfig.s3Prefix}uploads/${jobName}.wav`;
    const outputKey = `${awsConfig.s3Prefix}batch-output/${jobName}.json`;

    // Upload audio to S3
    const uploadStartTime = Date.now();
    await uploadToS3(
      awsConfig.s3Bucket,
      s3Key,
      audioBytes,
      "audio/wav",
      awsConfig
    );
    timings.uploadMs = Date.now() - uploadStartTime;

    console.log("[start-batch-audio] Uploaded to S3:", {
      bucket: awsConfig.s3Bucket,
      key: s3Key,
      bytes: audioBytes.byteLength,
      uploadMs: timings.uploadMs,
    });

    // Start transcription job
    const startJobTime = Date.now();
    const mediaUri = `s3://${awsConfig.s3Bucket}/${s3Key}`;
    await startMedicalTranscriptionJob(
      jobName,
      mediaUri,
      awsConfig.s3Bucket,
      outputKey,
      awsConfig
    );
    timings.startJobMs = Date.now() - startJobTime;
    timings.totalMs = Date.now() - requestStartTime;

    console.log("[start-batch-audio] Started transcription job:", {
      jobName,
      timings,
    });

    return jsonResponse({
      ok: true,
      jobName,
      meta: {
        timings,
        audioBytes: audioBytes.byteLength,
        estimatedDurationMs,
        awsRegion: awsConfig.region,
      }
    }, corsHeaders);
  } catch (err) {
    timings.totalMs = Date.now() - requestStartTime;
    console.error("[start-batch-audio] Error:", err);
    return errorResponse(
      err instanceof Error ? err.message : "Unknown error",
      500,
      corsHeaders
    );
  }
});
