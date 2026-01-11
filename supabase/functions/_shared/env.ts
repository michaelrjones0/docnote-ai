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
 * Check if an origin is allowed for CORS.
 * Strict allowlist - PHI-ready security.
 */
export function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  
  // Exact matches for known domains
  const exactAllowed = [
    'https://lovable.dev',
    'http://localhost:5173',
    'http://localhost:3000',
    'http://localhost:8080',
  ];
  
  if (exactAllowed.includes(origin)) {
    return true;
  }
  
  // Lovable preview domains: https://*.lovable.app (including id-preview--* pattern)
  if (/^https:\/\/[a-zA-Z0-9_-]+\.lovable\.app$/.test(origin)) {
    return true;
  }
  
  // Lovable preview domains with complex subdomains: https://id-preview--*.lovable.app
  if (/^https:\/\/id-preview--[a-zA-Z0-9-]+\.lovable\.app$/.test(origin)) {
    return true;
  }
  
  // Lovable project domains: https://*.lovableproject.com
  if (/^https:\/\/[a-zA-Z0-9_-]+\.lovableproject\.com$/.test(origin)) {
    return true;
  }
  
  // Check ALLOWED_ORIGINS env var for additional production domains
  const originsEnv = Deno.env.get('ALLOWED_ORIGINS') || '';
  const customOrigins = originsEnv.split(',').map(o => o.trim()).filter(Boolean);
  
  if (customOrigins.includes(origin)) {
    return true;
  }
  
  return false;
}

/**
 * Generate CORS headers for a request based on origin.
 * Strict behavior: never uses "*" - only echoes allowed origins.
 * Returns { headers, isAllowed } so callers can block disallowed origins.
 */
export function getCorsHeaders(origin: string | null): { headers: Record<string, string>; isAllowed: boolean } {
  const allowed = isAllowedOrigin(origin);
  
  // Base headers always present (for well-formed preflight responses)
  const baseHeaders: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
  };
  
  if (allowed && origin) {
    // Echo the allowed origin - never use "*"
    return {
      headers: {
        ...baseHeaders,
        'Access-Control-Allow-Origin': origin,
        'Vary': 'Origin',
      },
      isAllowed: true,
    };
  }
  
  // Origin not allowed - do NOT set Access-Control-Allow-Origin
  return {
    headers: baseHeaders,
    isAllowed: false,
  };
}
