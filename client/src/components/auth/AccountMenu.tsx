/**
 * src/components/auth/AccountMenu.tsx
 * -----------------------------------
 * Account menu in the chat header (Milestone 3): shows the verified
 * account (email + provider badge), lets the user edit their display
 * name, reviews/revokes ADDITIONAL Google permission grants, and signs
 * out (which revokes the Supabase session).
 *
 * SECURITY NOTES:
 * - Profile data comes from `GET /api/me` (server derives identity from
 *   the verified bearer token) — nothing here is trusted from the client.
 * - Email and provider are DISPLAY-ONLY; only `display_name` is sent in
 *   the PATCH body.
 * - Google login scopes are identity-only; the "permissions" section
 *   lists explicitly granted extra scopes (Gmail/Calendar) and lets the
 *   user revoke them. There is no in-app way to silently grant scopes.
 */

'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Loader2, LogOut, Pencil, ShieldCheck, X } from 'lucide-react';
import { useAuthStore } from '@/store/useAuthStore';
import { useProfileStore } from '@/store/useProfileStore';
import { cn } from '@/lib/utils';

/** Provider badge labels. */
const PROVIDER_LABELS: Record<string, string> = {
  google: 'Google',
  email: 'Email',
};

export function AccountMenu() {
  const user = useAuthStore((state) => state.user);
  const signOut = useAuthStore((state) => state.signOut);

  const profile = useProfileStore((state) => state.profile);
  const integrations = useProfileStore((state) => state.integrations);
  const status = useProfileStore((state) => state.status);
  const error = useProfileStore((state) => state.error);
  const isSaving = useProfileStore((state) => state.isSaving);
  const fetchProfile = useProfileStore((state) => state.fetch);
  const updateDisplayName = useProfileStore((state) => state.updateDisplayName);
  const revokeIntegration = useProfileStore((state) => state.revokeIntegration);
  const resetProfile = useProfileStore((state) => state.reset);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  // Load the profile the first time the menu opens.
  useEffect(() => {
    if (open && status === 'idle') {
      void fetchProfile();
    }
  }, [open, status, fetchProfile]);

  // Close when clicking outside (and on Escape).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const startEditing = () => {
    setNameDraft(profile?.display_name ?? '');
    setEditing(true);
  };

  const saveName = async () => {
    const ok = await updateDisplayName(nameDraft.trim() === '' ? null : nameDraft.trim());
    if (ok) setEditing(false);
  };

  const handleSignOut = async () => {
    setOpen(false);
    resetProfile();
    await signOut();
  };

  const email = profile?.email ?? user?.email ?? '';
  const initial = (profile?.display_name ?? email ?? '?').trim().charAt(0).toUpperCase();
  const activeGrants = integrations.filter((g) => g.revoked_at === null);

  return (
    <div ref={containerRef} className="relative ml-auto">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-200 text-[11px] font-semibold text-slate-600">
          {profile?.avatar_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={profile.avatar_url}
              alt=""
              className="h-6 w-6 rounded-full object-cover"
              referrerPolicy="no-referrer"
            />
          ) : (
            initial
          )}
        </span>
        <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-10 z-50 w-72 rounded-xl border border-slate-200 bg-white p-4 shadow-lg"
        >
          {/* Identity (read-only) */}
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-xs font-semibold text-slate-900">{email}</p>
              <span
                className={cn(
                  'mt-1 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium',
                  profile?.provider === 'google'
                    ? 'bg-blue-50 text-blue-700'
                    : 'bg-slate-100 text-slate-600',
                )}
              >
                {PROVIDER_LABELS[profile?.provider ?? 'email'] ?? 'Email'} account
              </span>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close account menu"
              className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>

          {/* Loading / error states */}
          {status === 'loading' && (
            <div className="mt-3 flex items-center gap-2 text-xs text-slate-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              Loading profile…
            </div>
          )}
          {error && (
            <p role="alert" className="mt-3 text-xs text-red-600">
              {error}
            </p>
          )}

          {/* Display name (the only editable field) */}
          {status === 'loaded' && profile && (
            <div className="mt-3">
              <p className="text-[10px] font-medium uppercase tracking-wide text-slate-400">
                Display name
              </p>
              {editing ? (
                <div className="mt-1 flex items-center gap-1.5">
                  <input
                    autoFocus
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    maxLength={80}
                    placeholder="Your name"
                    className="h-8 flex-1 rounded-md border border-slate-300 px-2 text-xs text-slate-800 focus:border-slate-400 focus:outline-none"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void saveName();
                      if (e.key === 'Escape') setEditing(false);
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => void saveName()}
                    disabled={isSaving}
                    className="h-8 rounded-md bg-slate-900 px-2.5 text-[11px] font-medium text-white hover:bg-slate-700 disabled:opacity-50"
                  >
                    {isSaving ? '…' : 'Save'}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={startEditing}
                  className="mt-1 flex w-full items-center justify-between rounded-md px-1 py-1 text-left text-xs text-slate-700 hover:bg-slate-50"
                >
                  <span className="truncate">
                    {profile.display_name ?? (
                      <span className="text-slate-400">Add a display name</span>
                    )}
                  </span>
                  <Pencil className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
                </button>
              )}
            </div>
          )}

          {/* Additional Google permissions (explicit consent records) */}
          {status === 'loaded' && (
            <div className="mt-3 border-t border-slate-100 pt-3">
              <p className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-slate-400">
                <ShieldCheck className="h-3 w-3" aria-hidden="true" />
                Google permissions
              </p>
              {activeGrants.length === 0 ? (
                <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                  Sign-in uses your name and email only. No extra Gmail or
                  Calendar access has been granted.
                </p>
              ) : (
                <ul className="mt-1.5 space-y-1.5">
                  {activeGrants.map((grant) => (
                    <li
                      key={grant.integration}
                      className="flex items-center justify-between gap-2 rounded-md bg-slate-50 px-2 py-1.5"
                    >
                      <span className="min-w-0 text-[11px] text-slate-600">
                        <span className="font-medium capitalize">{grant.integration}</span>
                        {' · '}
                        <span className="truncate">{grant.scopes.join(', ')}</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => void revokeIntegration(grant.integration)}
                        disabled={isSaving}
                        className="shrink-0 text-[11px] font-medium text-red-600 hover:underline disabled:opacity-50"
                      >
                        Revoke
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Sign out (revokes the Supabase session) */}
          <button
            type="button"
            onClick={() => void handleSignOut()}
            className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-md border border-slate-200 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900"
          >
            <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export default AccountMenu;
