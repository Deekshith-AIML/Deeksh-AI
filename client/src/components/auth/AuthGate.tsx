/**
 * src/components/auth/AuthGate.tsx
 * -------------------------------
 * Client-side route guard wrapping the dashboard.
 *
 * - Initializes the Supabase auth listener on mount.
 * - Shows a loading state while the session is being resolved.
 * - Redirects unauthenticated visitors to /login; renders `children`
 *   (the existing dashboard) only when authenticated.
 *
 * IMPORTANT: this guard is UX, not security. The backend verifies the
 * bearer token on every API request independently — even a user who
 * bypasses this component receives 401 responses for all data access.
 */

'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { useAuthStore } from '@/store/useAuthStore';

interface AuthGateProps {
  children: ReactNode;
}

export function AuthGate({ children }: AuthGateProps) {
  const router = useRouter();
  const status = useAuthStore((s) => s.status);
  const error = useAuthStore((s) => s.error);
  const initialize = useAuthStore((s) => s.initialize);

  // Subscribe to auth events + resolve the initial session once.
  useEffect(() => {
    initialize();
  }, [initialize]);

  // Unauthenticated → sign-in page.
  useEffect(() => {
    if (status === 'unauthenticated') {
      router.replace('/login');
    }
  }, [status, router]);

  // Still resolving the session.
  if (status === 'loading') {
    return (
      <main className="flex h-dvh w-full flex-col items-center justify-center gap-3 bg-slate-100">
        <Loader2 className="h-6 w-6 animate-spin text-slate-400" aria-hidden="true" />
        <p className="text-sm text-slate-500">Checking your session…</p>
      </main>
    );
  }

  // Signed out (redirect is in flight) or configuration error.
  if (status === 'unauthenticated') {
    return (
      <main className="flex h-dvh w-full items-center justify-center bg-slate-100 px-4">
        <div className="max-w-sm rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error ?? 'You need to sign in to continue. Redirecting to the sign-in page…'}
        </div>
      </main>
    );
  }

  return <>{children}</>;
}

export default AuthGate;
