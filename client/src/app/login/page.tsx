/**
 * src/app/login/page.tsx
 * ----------------------
 * Sign-in / sign-up screen for the Task Assistant (email + password via
 * Supabase Auth).
 *
 * - Toggle between sign-in and sign-up modes.
 * - Displays Supabase auth errors and post-sign-up notices clearly.
 * - Redirects to the dashboard when a session already exists or is
 *   established. The dashboard itself is additionally protected by
 *   AuthGate — frontend guards are UX only; the backend re-verifies
 *   every request independently.
 */

'use client';

import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Bot, Loader2 } from 'lucide-react';
import { useAuthStore } from '@/store/useAuthStore';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';

type Mode = 'sign-in' | 'sign-up';

/**
 * Login content. Lives under a Suspense boundary because `useSearchParams`
 * requires it for static prerendering (Next.js App Router requirement).
 */
function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const status = useAuthStore((s) => s.status);
  const error = useAuthStore((s) => s.error);
  const notice = useAuthStore((s) => s.notice);
  const isSubmitting = useAuthStore((s) => s.isSubmitting);
  const signIn = useAuthStore((s) => s.signIn);
  const signUp = useAuthStore((s) => s.signUp);
  const clearError = useAuthStore((s) => s.clearError);

  const [mode, setMode] = useState<Mode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // Show why the user landed here (e.g. kicked out on expired session).
  const reason = searchParams.get('reason');
  const expiredNotice =
    reason === 'session_expired' ? 'Your session expired. Please sign in again.' : null;

  // Already authenticated → go to the dashboard.
  useEffect(() => {
    if (status === 'authenticated') {
      router.replace('/');
    }
  }, [status, router]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    clearError();

    const ok =
      mode === 'sign-in'
        ? await signIn(email, password)
        : await signUp(email, password);

    // Successful sign-in (or sign-up with auto-confirm) → dashboard.
    if (ok && mode === 'sign-in') {
      router.replace('/');
    }
    // For sign-up without a session the notice tells the user to confirm.
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    clearError();
  };

  return (
    <main className="flex min-h-dvh items-center justify-center bg-slate-100 px-4 py-10">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        {/* Brand header */}
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-slate-900 text-white">
            <Bot className="h-6 w-6" aria-hidden="true" />
          </div>
          <h1 className="text-lg font-semibold text-slate-900">TaskMate</h1>
          <p className="mt-1 text-xs text-slate-500">
            {mode === 'sign-in' ? 'Sign in to your account' : 'Create a new account'}
          </p>
        </div>

        {/* Session-expiry notice */}
        {expiredNotice && (
          <div
            role="status"
            className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
          >
            {expiredNotice}
          </div>
        )}

        {/* Supabase sign-up notice */}
        {notice && (
          <div
            role="status"
            className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800"
          >
            {notice}
          </div>
        )}

        {/* Auth error */}
        {error && (
          <div
            role="alert"
            className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
          >
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label htmlFor="email" className="mb-1 block text-xs font-medium text-slate-600">
              Email
            </label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              disabled={isSubmitting}
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-1 block text-xs font-medium text-slate-600">
              Password
            </label>
            <Input
              id="password"
              type="password"
              autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              disabled={isSubmitting}
            />
          </div>

          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {mode === 'sign-in' ? 'Sign in' : 'Sign up'}
          </Button>
        </form>

        {/* Mode toggle */}
        <p className="mt-4 text-center text-xs text-slate-500">
          {mode === 'sign-in' ? 'No account yet?' : 'Already have an account?'}{' '}
          <button
            type="button"
            onClick={() => switchMode(mode === 'sign-in' ? 'sign-up' : 'sign-in')}
            className="font-medium text-slate-900 underline underline-offset-2 hover:no-underline"
            disabled={isSubmitting}
          >
            {mode === 'sign-in' ? 'Sign up' : 'Sign in'}
          </button>
        </p>
      </div>
    </main>
  );
}

/** Sign-in / sign-up route (Suspense-wrapped for useSearchParams). */
export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-dvh items-center justify-center bg-slate-100">
          <Loader2 className="h-6 w-6 animate-spin text-slate-400" aria-hidden="true" />
        </main>
      }
    >
      <LoginContent />
    </Suspense>
  );
}
