/**
 * Shared authentication helper for edge functions.
 * Centralizes JWT verification - single source of truth.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

export interface AuthResult {
  userId: string;
}

export interface AuthError {
  error: Response;
}

/**
 * Verify the JWT from the Authorization header and return userId.
 * Returns either { userId } on success or { error: Response } on failure.
 * 
 * SECURITY: No tokens, request bodies, or PHI are logged.
 * 
 * @param req - The incoming request
 * @param corsHeaders - CORS headers to include in error responses
 */
export async function requireUser(
  req: Request,
  corsHeaders: Record<string, string>
): Promise<AuthResult | AuthError> {
  const authHeader = req.headers.get("Authorization");
  
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return {
      error: new Response(
        JSON.stringify({ error: "Unauthorized: missing or invalid Authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      ),
    };
  }

  const token = authHeader.replace("Bearer ", "");

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");

  if (!supabaseUrl || !supabaseAnonKey) {
    console.error("[auth] Supabase env vars not configured");
    return {
      error: new Response(
        JSON.stringify({ error: "Server configuration error" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      ),
    };
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false },
  });

  // Use getUser to verify the token (more reliable than getClaims for user verification)
  const { data: { user }, error } = await supabase.auth.getUser(token);

  if (error || !user) {
    // Log only that auth failed, not the token or any PHI
    console.error("[auth] JWT verification failed");
    return {
      error: new Response(
        JSON.stringify({ error: "Unauthorized: invalid or expired token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      ),
    };
  }

  return { userId: user.id };
}

/**
 * Type guard to check if auth result is an error.
 */
export function isAuthError(result: AuthResult | AuthError): result is AuthError {
  return "error" in result;
}
