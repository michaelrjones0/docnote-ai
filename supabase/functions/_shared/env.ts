/**
 * Shared environment variable helpers for edge functions
 */

export interface AwsConfig {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  s3Bucket: string;
  s3Prefix: string;
}

export interface CorsConfig {
  allowedOrigins: string[];
}

/**
 * Get a required environment variable. Throws if missing.
 */
export function getRequiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Get an optional environment variable with a default value.
 */
export function getOptionalEnv(name: string, defaultValue: string): string {
  return Deno.env.get(name) || defaultValue;
}

/**
 * Get validated AWS configuration from environment variables.
 * Required: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_S3_BUCKET
 * Optional: AWS_REGION (default: us-west-2), AWS_S3_PREFIX (default: transcribe/)
 */
export function getAwsConfig(): AwsConfig {
  return {
    accessKeyId: getRequiredEnv('AWS_ACCESS_KEY_ID'),
    secretAccessKey: getRequiredEnv('AWS_SECRET_ACCESS_KEY'),
    region: getOptionalEnv('AWS_REGION', 'us-west-2'),
    s3Bucket: getRequiredEnv('AWS_S3_BUCKET'),
    s3Prefix: getOptionalEnv('AWS_S3_PREFIX', 'transcribe/'),
  };
}

/**
 * Get CORS configuration from environment variables.
 * Optional: ALLOWED_ORIGINS (default: localhost)
 */
export function getCorsConfig(): CorsConfig {
  const originsEnv = Deno.env.get('ALLOWED_ORIGINS') || '';
  const allowedOrigins = originsEnv.split(',').map(o => o.trim()).filter(Boolean);
  
  // Default to localhost for development if no origins configured
  if (allowedOrigins.length === 0) {
    allowedOrigins.push('http://localhost:5173', 'http://localhost:3000');
  }
  
  return { allowedOrigins };
}

/**
 * Generate CORS headers for a request based on origin.
 */
export function getCorsHeaders(origin: string | null): Record<string, string> {
  const { allowedOrigins } = getCorsConfig();
  
  const isAllowed = origin && allowedOrigins.some(allowed => 
    allowed === '*' || origin === allowed || origin.endsWith(allowed.replace('*', ''))
  );
  
  return {
    'Access-Control-Allow-Origin': isAllowed && origin ? origin : allowedOrigins[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}
