/**
 * usePublicConfig - Fetches and caches runtime configuration from the server
 * 
 * Replaces VITE_* build-time variables with runtime config from the
 * public-config edge function. Caches the result for the session.
 */

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { safeLog, safeWarn, safeErrorLog } from '@/lib/debug';

export interface PublicConfig {
  deepgramRelayUrl: string;
}

interface UsePublicConfigResult {
  config: PublicConfig | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

// In-memory cache for the current session
let cachedConfig: PublicConfig | null = null;
let fetchPromise: Promise<PublicConfig | null> | null = null;

export function usePublicConfig(): UsePublicConfigResult {
  const [config, setConfig] = useState<PublicConfig | null>(cachedConfig);
  const [isLoading, setIsLoading] = useState(!cachedConfig);
  const [error, setError] = useState<string | null>(null);

  const fetchConfig = useCallback(async (): Promise<PublicConfig | null> => {
    try {
      safeLog('[PublicConfig] Fetching runtime config...');
      
      const { data, error: fnError } = await supabase.functions.invoke('public-config', {
        method: 'GET',
      });

      if (fnError) {
        throw new Error(fnError.message || 'Failed to fetch config');
      }

      const fetchedConfig: PublicConfig = {
        deepgramRelayUrl: data?.deepgramRelayUrl || '',
      };

      safeLog(`[PublicConfig] Fetched: relay=${fetchedConfig.deepgramRelayUrl ? 'configured' : 'not configured'}`);
      
      cachedConfig = fetchedConfig;
      return fetchedConfig;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      safeErrorLog('[PublicConfig] Fetch failed:', err);
      throw new Error(errMsg);
    }
  }, []);

  const refetch = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    cachedConfig = null;
    fetchPromise = null;
    
    try {
      const newConfig = await fetchConfig();
      setConfig(newConfig);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Failed to load config';
      setError(errMsg);
    } finally {
      setIsLoading(false);
    }
  }, [fetchConfig]);

  useEffect(() => {
    // If we have cached config, use it
    if (cachedConfig) {
      setConfig(cachedConfig);
      setIsLoading(false);
      return;
    }

    // If a fetch is already in progress, wait for it
    if (fetchPromise) {
      fetchPromise
        .then((result) => {
          setConfig(result);
          setError(null);
        })
        .catch((err) => {
          setError(err.message);
        })
        .finally(() => {
          setIsLoading(false);
        });
      return;
    }

    // Start a new fetch
    fetchPromise = fetchConfig();
    
    fetchPromise
      .then((result) => {
        setConfig(result);
        setError(null);
      })
      .catch((err) => {
        setError(err.message);
        safeWarn('[PublicConfig] Using fallback - relay not available');
      })
      .finally(() => {
        setIsLoading(false);
        fetchPromise = null;
      });
  }, [fetchConfig]);

  return {
    config,
    isLoading,
    error,
    refetch,
  };
}

/**
 * Get the cached config synchronously (for use outside React)
 * Returns null if config hasn't been fetched yet
 */
export function getCachedConfig(): PublicConfig | null {
  return cachedConfig;
}

/**
 * Check if Deepgram streaming is available based on cached config
 */
export function isStreamingConfigured(): boolean {
  return Boolean(cachedConfig?.deepgramRelayUrl);
}
