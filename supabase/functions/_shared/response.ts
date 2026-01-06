/**
 * Shared response helpers for edge functions.
 * Ensures consistent JSON responses with proper CORS headers.
 */

/**
 * Create a JSON success response with CORS headers.
 * 
 * @param data - The response data
 * @param corsHeaders - CORS headers from getCorsHeaders
 * @param status - HTTP status code (default: 200)
 */
export function jsonResponse(
  data: unknown,
  corsHeaders: Record<string, string>,
  status = 200
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Create a JSON error response with CORS headers.
 * 
 * IMPORTANT: Only includes Access-Control-Allow-Origin when origin is allowed.
 * This is already handled by getCorsHeaders - the corsHeaders param should come
 * from getCorsHeaders output.
 * 
 * @param message - User-facing error message (no PHI)
 * @param status - HTTP status code
 * @param corsHeaders - CORS headers from getCorsHeaders
 * @param code - Optional error code for client handling
 */
export function errorResponse(
  message: string,
  status: number,
  corsHeaders: Record<string, string>,
  code?: string
): Response {
  const body: Record<string, string> = { error: message };
  if (code) {
    body.code = code;
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
