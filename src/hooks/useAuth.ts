import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { User, Session } from '@supabase/supabase-js';

export type AppRole = 'admin' | 'staff' | 'provider';

interface AuthState {
  user: User | null;
  session: Session | null;
  roles: AppRole[];
  isLoading: boolean;
}

export function useAuth() {
  const [authState, setAuthState] = useState<AuthState>({
    user: null,
    session: null,
    roles: [],
    isLoading: true,
  });

  const fetchRoles = useCallback(async () => {
    // RLS policy filters to current user via auth.uid() - no need to pass user_id
    const { data, error } = await supabase
      .from('user_roles')
      .select('role');
    
    if (error) {
      return [];
    }
    
    return data?.map(r => r.role as AppRole) || [];
  }, []);

  useEffect(() => {
    // Set up auth state listener FIRST
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        setAuthState(prev => ({
          ...prev,
          session,
          user: session?.user ?? null,
        }));

        // Defer role fetching with setTimeout
        if (session?.user) {
          setTimeout(async () => {
            const roles = await fetchRoles();
            setAuthState(prev => ({
              ...prev,
              roles,
              isLoading: false,
            }));
          }, 0);
        } else {
          setAuthState(prev => ({
            ...prev,
            roles: [],
            isLoading: false,
          }));
        }
      }
    );

    // THEN check for existing session
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      setAuthState(prev => ({
        ...prev,
        session,
        user: session?.user ?? null,
      }));

      if (session?.user) {
        const roles = await fetchRoles();
        setAuthState(prev => ({
          ...prev,
          roles,
          isLoading: false,
        }));
      } else {
        setAuthState(prev => ({
          ...prev,
          isLoading: false,
        }));
      }
    });

    return () => subscription.unsubscribe();
  }, [fetchRoles]);

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error };
  };

  const signUp = async (email: string, password: string, fullName: string) => {
    const redirectUrl = `${window.location.origin}/`;
    
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: redirectUrl,
        data: { full_name: fullName }
      }
    });
    return { error };
  };

  const signOut = async () => {
    const { error } = await supabase.auth.signOut();
    return { error };
  };

  const hasRole = (role: AppRole) => authState.roles.includes(role);
  const hasAnyRole = () => authState.roles.length > 0;
  const isProvider = () => hasRole('provider');
  const isAdmin = () => hasRole('admin');
  const isStaff = () => hasRole('staff');

  return {
    ...authState,
    signIn,
    signUp,
    signOut,
    hasRole,
    hasAnyRole,
    isProvider,
    isAdmin,
    isStaff,
  };
}