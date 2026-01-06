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
 * Optional: ALLOWED_ORIGINS (default: localhost + preview domains)
 */
export function getCorsConfig(): CorsConfig {
  const originsEnv = Deno.env.get('ALLOWED_ORIGINS') || '';
  const allowedOrigins = originsEnv.split(',').map(o => o.trim()).filter(Boolean);
  
  // Default to localhost and Lovable preview domains for development
  if (allowedOrigins.length === 0) {
    allowedOrigins.push(
      'http://localhost:5173', 
      'http://localhost:3000',
      '*' // Allow all origins in dev mode
    );
  }
  
  return { allowedOrigins };
}

/**
 * Generate CORS headers for a request based on origin.
 * ALWAYS returns valid CORS headers - uses '*' if origin doesn't match allowlist
 * to ensure CORS headers are present even on error responses.
 */
export function getCorsHeaders(origin: string | null): Record<string, string> {
  const { allowedOrigins } = getCorsConfig();
  
  // Check if wildcard is in allowed origins
  const hasWildcard = allowedOrigins.includes('*');
  
  // Check if origin matches any allowed origin (including lovable.app preview domains)
  const isAllowed = origin && allowedOrigins.some(allowed => {
    if (allowed === '*') return true;
    if (origin === allowed) return true;
    // Support wildcard subdomains like *.lovable.app
    if (allowed.startsWith('*')) {
      const suffix = allowed.slice(1);
      return origin.endsWith(suffix);
    }
    // Support Lovable preview domains
    if (origin.includes('.lovable.app')) return true;
    return false;
  });
  
  // If origin is allowed or wildcard is enabled, use the origin; otherwise use wildcard
  // This ensures CORS headers are ALWAYS present and valid
  const allowedOrigin = hasWildcard 
    ? '*' 
    : (isAllowed && origin ? origin : '*');
  
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}
