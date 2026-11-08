/**
 * src/components/memory/MemoryPanel.tsx
 * -------------------------------------
 * Memory Dashboard (Milestone 4 / 4.1) — rendered in the right pane below
 * the reminder panel.
 *
 * Shows:
 * - Consent settings (automatic extraction OFF by default; sensitive
 *   memories excluded from chat unless explicitly enabled; configurable
 *   similarity threshold) — every toggle is an explicit user action.
 * - Search, category and status filters that query the backend.
 * - Memories requiring review, with a side-by-side comparison against the
 *   memory they conflict with and an explicit supersession confirmation.
 * - Active memories with category/status/sensitivity pills, provenance,
 *   and created/modified timestamps.
 * - Add / edit / delete actions. Supersession is only offered as an
 *   explicit confirmation — nothing supersedes automatically.
 *
 * SECURITY: no user id is sent — identity comes from the bearer token.
 * Credential-class content is rejected server-side (surfaced as an error).
 */

'use client';

import { useEffect, useState, type FormEvent } from 'react';
import {
  Brain,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Trash2,
  Pencil,
  Plus,
  X,
  Search,
  Link2,
  Calendar,
} from 'lucide-react';
import { useMemoryStore } from '@/store/useMemoryStore';
import { Button } from '@/components/ui/Button';
import type { Memory, MemoryCategory } from '@/types';

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

const CATEGORY_LABELS: Record<MemoryCategory, string> = {
  personal_fact: 'Personal fact',
  user_preference: 'Preference',
  career_goal: 'Career goal',
  project: 'Project',
  important_event: 'Event',
  learning_preference: 'Learning',
  work_info: 'Work',
  recurring_info: 'Recurring',
  other: 'Other',
};

const SENSITIVITY_STYLES: Record<string, string> = {
  normal: 'bg-slate-100 text-slate-600 ring-slate-200',
  sensitive: 'bg-amber-100 text-amber-700 ring-amber-200',
  credential: 'bg-red-100 text-red-700 ring-red-200',
};

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

function CategoryPill({ category }: { category: MemoryCategory }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700 ring-1 ring-indigo-200">
      {CATEGORY_LABELS[category] ?? category}
    </span>
  );
}

function SensitivityPill({ sensitivity }: { sensitivity: string }) {
  if (sensitivity === 'normal') return null;
  return (
    <span
      data-sensitivity={sensitivity}
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${SENSITIVITY_STYLES[sensitivity] ?? SENSITIVITY_STYLES.normal!}`}
    >
      {sensitivity === 'sensitive' ? 'Sensitive' : 'Credential'}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Settings section (consent controls)
// ---------------------------------------------------------------------------

function ToggleRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 py-2">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 disabled:opacity-50"
      />
      <span className="min-w-0">
        <span className="block text-xs font-medium text-slate-800">{label}</span>
        <span className="block text-[11px] leading-relaxed text-slate-500">{description}</span>
      </span>
    </label>
  );
}

function SettingsSection() {
  const settings = useMemoryStore((s) => s.settings);
  const updateSettings = useMemoryStore((s) => s.updateSettings);
  const isMutating = useMemoryStore((s) => s.isMutating);

  if (!settings) return null;

  return (
    <div className="mb-4 rounded-lg border border-slate-200 bg-white p-4">
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
        Memory consent
      </h3>
      <ToggleRow
        label="Automatic memory extraction"
        description="Off by default. When off, the assistant only remembers what you explicitly ask it to remember."
        checked={settings.automatic_memory_extraction}
        disabled={isMutating}
        onChange={(v) => updateSettings({ automatic_memory_extraction: v })}
      />
      <ToggleRow
        label="Use memories in chat"
        description="Retrieved memories are added as untrusted reference data — never as instructions."
        checked={settings.include_memory_in_chat}
        disabled={isMutating}
        onChange={(v) => updateSettings({ include_memory_in_chat: v })}
      />
      <ToggleRow
        label="Include sensitive memories in chat"
        description="Off by default. Sensitive memories stay out of automatic chat context unless you enable this."
        checked={settings.include_sensitive_in_chat}
        disabled={isMutating}
        onChange={(v) => updateSettings({ include_sensitive_in_chat: v })}
      />
      <div className="mt-2 flex items-center gap-2">
        <label htmlFor="memory-threshold" className="text-xs font-medium text-slate-800">
          Similarity threshold
        </label>
        <input
          id="memory-threshold"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={settings.similarity_threshold}
          disabled={isMutating}
          onChange={(e) => updateSettings({ similarity_threshold: Number(e.target.value) })}
          className="h-1 flex-1 accent-indigo-600"
        />
        <span className="w-9 text-right text-xs tabular-nums text-slate-600">
          {settings.similarity_threshold.toFixed(2)}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add-memory form
// ---------------------------------------------------------------------------

function AddMemoryForm() {
  const createMemory = useMemoryStore((s) => s.createMemory);
  const isMutating = useMemoryStore((s) => s.isMutating);
  const [content, setContent] = useState('');
  const [category, setCategory] = useState<MemoryCategory>('personal_fact');
  const [open, setOpen] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!content.trim()) return;
    const created = await createMemory({ content: content.trim(), category });
    if (created) {
      setContent('');
      setOpen(false);
    }
  }

  if (!open) {
    return (
      <Button type="button" variant="secondary" onClick={() => setOpen(true)} className="mb-3">
        <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
        Add memory
      </Button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mb-4 rounded-lg border border-indigo-200 bg-indigo-50/50 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold text-slate-700">Remember something</h3>
        <button type="button" onClick={() => setOpen(false)} aria-label="Close add memory form">
          <X className="h-4 w-4 text-slate-400 hover:text-slate-600" aria-hidden="true" />
        </button>
      </div>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="e.g. I prefer Python for scripting."
        rows={2}
        maxLength={4000}
        className="mb-2 w-full resize-none rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
      />
      <div className="flex items-center gap-2">
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as MemoryCategory)}
          className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-700 focus:border-indigo-500 focus:outline-none"
        >
          {(Object.keys(CATEGORY_LABELS) as MemoryCategory[]).map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
        <Button type="submit" variant="default" disabled={isMutating || !content.trim()}>
          {isMutating ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
          Save
        </Button>
      </div>
      <p className="mt-2 text-[11px] text-slate-500">
        Credentials and secrets are never stored as memories.
      </p>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Memory row
// ---------------------------------------------------------------------------

function MemoryRow({
  memory,
  conflict,
}: {
  memory: Memory;
  /** The memory this row contradicts (needs_review rows only). */
  conflict?: Memory;
}) {
  const updateMemory = useMemoryStore((s) => s.updateMemory);
  const deleteMemory = useMemoryStore((s) => s.deleteMemory);
  const supersedeMemory = useMemoryStore((s) => s.supersedeMemory);
  const isMutating = useMemoryStore((s) => s.isMutating);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(memory.content);
  const [confirming, setConfirming] = useState(false);

  async function saveEdit() {
    if (!draft.trim() || draft.trim() === memory.content) {
      setEditing(false);
      return;
    }
    const updated = await updateMemory(memory.id, { content: draft.trim() });
    if (updated) setEditing(false);
  }

  const needsReview = memory.status === 'needs_review';

  return (
    <li
      className={`rounded-lg border p-3 ${
        needsReview ? 'border-amber-300 bg-amber-50/40' : 'border-slate-200 bg-white'
      }`}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        <CategoryPill category={memory.category} />
        <SensitivityPill sensitivity={memory.sensitivity} />
        {needsReview ? (
          <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700 ring-1 ring-amber-200">
            Needs review
          </span>
        ) : null}
        {memory.source_evidence ? (
          <span
            title={`From your message: ${memory.source_evidence}`}
            className="ml-auto inline-flex items-center gap-1 text-[10px] text-slate-400"
          >
            <Link2 className="h-3 w-3" aria-hidden="true" />
            sourced
          </span>
        ) : null}
      </div>

      {editing ? (
        <div className="flex items-start gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            maxLength={4000}
            className="flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
          />
          <div className="flex flex-col gap-1">
            <Button type="button" variant="default" disabled={isMutating} onClick={saveEdit}>
              Save
            </Button>
            <Button type="button" variant="secondary" onClick={() => { setDraft(memory.content); setEditing(false); }}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm text-slate-800">{memory.content}</p>
          <div className="flex shrink-0 gap-1">
            <button
              type="button"
              aria-label="Edit memory"
              onClick={() => setEditing(true)}
              className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Delete memory"
              disabled={isMutating}
              onClick={() => deleteMemory(memory.id)}
              className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
      )}

      {needsReview && memory.conflict_with ? (
        <div className="mt-2 rounded-md border border-amber-200 bg-white px-2.5 py-2">
          <p className="mb-1 text-[11px] font-semibold text-amber-800">
            This may conflict with an existing memory
          </p>
          <p className="mb-2 whitespace-pre-wrap rounded bg-slate-50 px-2 py-1.5 text-xs text-slate-700">
            {conflict ? conflict.content : `Memory ${memory.conflict_with} (not in the current view)`}
          </p>
          {conflict ? (
            <p className="mb-2 text-[11px] text-slate-500">
              Existing since {formatDate(conflict.created_at)}
            </p>
          ) : null}
          {confirming ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-slate-600">
                Keep the new statement and mark the older one as superseded?
              </span>
              <Button
                type="button"
                variant="default"
                disabled={isMutating}
                onClick={async () => {
                  const ok = await supersedeMemory(memory.conflict_with!, memory.id);
                  if (ok) setConfirming(false);
                }}
              >
                Yes, replace
              </Button>
              <Button type="button" variant="secondary" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button type="button" variant="secondary" onClick={() => setConfirming(true)}>
              Confirm replacement
            </Button>
          )}
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-3 text-[10px] text-slate-400">
        <span className="inline-flex items-center gap-1">
          <Calendar className="h-3 w-3" aria-hidden="true" />
          Created {formatDate(memory.created_at)}
        </span>
        <span>Modified {formatDate(memory.updated_at)}</span>
        {memory.source_evidence ? (
          <span className="min-w-0 truncate" title={memory.source_evidence}>
            Evidence: {memory.source_evidence}
          </span>
        ) : null}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Search / filter bar
// ---------------------------------------------------------------------------

function FilterBar({
  query,
  category,
  status,
  onQueryChange,
  onCategoryChange,
  onStatusChange,
  onSubmit,
  onReset,
}: {
  query: string;
  category: string;
  status: 'all' | 'active' | 'needs_review';
  onQueryChange: (v: string) => void;
  onCategoryChange: (v: string) => void;
  onStatusChange: (v: 'all' | 'active' | 'needs_review') => void;
  onSubmit: () => void;
  onReset: () => void;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="mb-3 flex flex-wrap items-center gap-2"
    >
      <div className="relative min-w-0 flex-1">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search memories…"
          aria-label="Search memories"
          className="w-full rounded-md border border-slate-300 bg-white py-1.5 pl-7 pr-2 text-xs text-slate-800 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />
      </div>
      <select
        value={category}
        onChange={(e) => onCategoryChange(e.target.value)}
        aria-label="Filter by category"
        className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-700 focus:border-indigo-500 focus:outline-none"
      >
        <option value="">All categories</option>
        {(Object.keys(CATEGORY_LABELS) as MemoryCategory[]).map((c) => (
          <option key={c} value={c}>
            {CATEGORY_LABELS[c]}
          </option>
        ))}
      </select>
      <select
        value={status}
        onChange={(e) => onStatusChange(e.target.value as 'all' | 'active' | 'needs_review')}
        aria-label="Filter by status"
        className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-700 focus:border-indigo-500 focus:outline-none"
      >
        <option value="all">All statuses</option>
        <option value="active">Active</option>
        <option value="needs_review">Needs review</option>
      </select>
      <Button type="submit" variant="secondary">Apply</Button>
      <Button type="button" variant="ghost" onClick={onReset}>Reset</Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function MemoryPanel() {
  const memories = useMemoryStore((s) => s.memories);
  const isLoading = useMemoryStore((s) => s.isLoading);
  const error = useMemoryStore((s) => s.error);
  const successMessage = useMemoryStore((s) => s.successMessage);
  const fetchMemories = useMemoryStore((s) => s.fetchMemories);
  const fetchSettings = useMemoryStore((s) => s.fetchSettings);
  const clearError = useMemoryStore((s) => s.clearError);
  const clearSuccess = useMemoryStore((s) => s.clearSuccess);

  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState<'all' | 'active' | 'needs_review'>('all');

  useEffect(() => {
    void fetchMemories();
    void fetchSettings();
  }, [fetchMemories, fetchSettings]);

  const apply = (next?: { q?: string; category?: string; status?: 'active' | 'needs_review' }) => {
    void fetchMemories({
      q: next?.q ?? query,
      category: next?.category ?? category,
      status: next?.status ?? (status === 'all' ? undefined : status),
    });
  };

  const reset = () => {
    setQuery('');
    setCategory('');
    setStatus('all');
    void fetchMemories();
  };

  const byId = new Map(memories.map((m) => [m.id, m]));
  const review = memories.filter((m) => m.status === 'needs_review');
  const active = memories.filter((m) => m.status === 'active');

  return (
    <section aria-label="Long-term memory" className="mb-4">
      <header className="mb-2 flex items-center gap-2">
        <Brain className="h-5 w-5 text-indigo-600" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-slate-900">Memory</h2>
        <span className="text-xs text-slate-400">
          {active.length} active{review.length > 0 ? ` · ${review.length} to review` : ''}
        </span>
      </header>

      {error ? (
        <div role="alert" className="mb-3 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="flex-1">{error}</span>
          <button type="button" onClick={clearError} className="font-medium underline hover:no-underline">
            Dismiss
          </button>
        </div>
      ) : null}

      {successMessage ? (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="flex-1">{successMessage}</span>
          <button type="button" onClick={clearSuccess} className="font-medium underline hover:no-underline">
            Dismiss
          </button>
        </div>
      ) : null}

      <SettingsSection />
      <AddMemoryForm />
      <FilterBar
        query={query}
        category={category}
        status={status}
        onQueryChange={setQuery}
        onCategoryChange={(v) => {
          setCategory(v);
          apply({ category: v });
        }}
        onStatusChange={(v) => {
          setStatus(v);
          apply({ status: v === 'all' ? undefined : v });
        }}
        onSubmit={() => apply()}
        onReset={reset}
      />

      {isLoading ? (
        <div className="flex items-center justify-center gap-2 py-6 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading memories…
        </div>
      ) : memories.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 bg-white/60 px-4 py-6 text-center text-xs text-slate-500">
          No memories match. Ask the assistant to remember something, add one above, or clear the filters.
        </p>
      ) : (
        <div className="space-y-3">
          {review.length > 0 ? (
            <div>
              <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-700">
                Needs review ({review.length})
              </h3>
              <ul className="space-y-2">
                {review.map((m) => (
                  <MemoryRow
                    key={m.id}
                    memory={m}
                    conflict={m.conflict_with ? byId.get(m.conflict_with) : undefined}
                  />
                ))}
              </ul>
            </div>
          ) : null}

          {active.length > 0 ? (
            <div>
              {review.length > 0 ? (
                <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Active ({active.length})
                </h3>
              ) : null}
              <ul className="space-y-2">
                {active.map((m) => (
                  <MemoryRow key={m.id} memory={m} />
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

export default MemoryPanel;
