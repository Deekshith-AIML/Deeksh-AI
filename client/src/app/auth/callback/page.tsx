/**
 * src/app/auth/callback/page.tsx
 * ------------------------------
 * OAuth redirect target for "Continue with Google" (Milestone 3).
 *
 * Flow:
 *   1. Classify the callback query string with the pure
 *      `parseOAuthCallback` helper (error precedence, code charset).
 *   2. If a session already exists (supabase-js `detectSessionInUrl`
 *      auto-exchange may have consumed the code first), we are done.
 *   3. Otherwise exchange the code ourselves — supabase-js validates the
 *      PKCE `state`/verifier during this call.
 *   4. Exchange lost the race (code already redeemed) → re-check for a
 *      session before reporting failure.
 *
 * Failures render a sanitized message only; raw provider errors are
 * logged to the console, never rendered (URL input is untrusted).
 */

'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Bot, Loader2, ShieldAlert } from 'lucide-react';
import { getSupabase } from '@/lib/supabase';
import { parseOAuthCallback } from '@/lib/oauthCallback';

export default function AuthCallbackPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    // React StrictMode double-invokes effects — run exactly once.
    if (startedRef.current) return;
    startedRef.current = true;

    void (async () => {
      const parsed = parseOAuthCallback(new URLSearchParams(window.location.search));

      if (parsed.kind !== 'success') {
        setError(parsed.reason);
        return;
      }

      try {
        const supabase = getSupabase();

        // 1. The client may have already exchanged the code on init.
        const { data: existing } = await supabase.auth.getSession();
        if (existing.session) {
          router.replace('/');
          return;
        }

        // 2. Exchange the code ourselves (state + PKCE validated here).
        const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(
          parsed.code,
        );
        if (!exchangeError) {
          router.replace('/');
          return;
        }

        // 3. Race with the auto-exchange: a session may exist now.
        const { data: after } = await supabase.auth.getSession();
        if (after.session) {
          router.replace('/');
          return;
        }

        console.error('OAuth code exchange failed:', exchangeError.message);
        setError('Could not complete Google sign-in. Please try again.');
      } catch (err) {
        console.error('OAuth callback failed:', err);
        setError('Could not complete Google sign-in. Please try again.');
      }
    })();
  }, [router]);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-slate-100 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-slate-900 text-white">
          <Bot className="h-5 w-5" aria-hidden="true" />
        </div>

        {error ? (
          <>
            <ShieldAlert
              className="mx-auto mb-3 h-8 w-8 text-amber-500"
              aria-hidden="true"
            />
            <h1 className="text-sm font-semibold text-slate-900">
              Sign-in didn&apos;t complete
            </h1>
            <p className="mt-2 text-xs leading-relaxed text-slate-500">{error}</p>
            <Link
              href="/login"
              className="mt-5 inline-flex h-9 items-center justify-center rounded-lg bg-slate-900 px-4 text-xs font-medium text-white transition-colors hover:bg-slate-700"
            >
              Back to sign in
            </Link>
          </>
        ) : (
          <>
            <Loader2
              className="mx-auto mb-3 h-6 w-6 animate-spin text-slate-400"
              aria-hidden="true"
            />
            <h1 className="text-sm font-semibold text-slate-900">
              Completing sign-in…
            </h1>
            <p className="mt-2 text-xs text-slate-500">
              Verifying your Google session.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
