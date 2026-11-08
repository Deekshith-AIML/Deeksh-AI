/**
 * src/app/page.tsx
 * ----------------
 * Main dashboard — a responsive split-screen layout:
 * - Left pane (~35%): AI chat (ChatContainer + ChatInput)
 * - Right pane (~65%): Kanban board with three task columns
 *
 * On small screens the panes stack vertically (chat on top, board below).
 */

'use client';

import { Bot, ListTodo } from 'lucide-react';
import ChatContainer from '@/components/chat/ChatContainer';
import ChatInput from '@/components/chat/ChatInput';
import KanbanBoard from '@/components/tasks/KanbanBoard';
import ReminderPanel from '@/components/reminders/ReminderPanel';
import MemoryPanel from '@/components/memory/MemoryPanel';
import AuthGate from '@/components/auth/AuthGate';
import AccountMenu from '@/components/auth/AccountMenu';
import { useChatStore } from '@/store/useChatStore';

/** Chat error banner shown above the input when a send fails. */
function ChatErrorBanner() {
  const error = useChatStore((state) => state.error);
  const clearError = useChatStore((state) => state.clearError);

  if (!error) return null;

  return (
    <div
      role="alert"
      className="flex items-center gap-2 border-t border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700"
    >
      <span className="flex-1">{error}</span>
      <button
        type="button"
        onClick={clearError}
        className="font-medium underline hover:no-underline"
      >
        Dismiss
      </button>
    </div>
  );
}

/**
 * The dashboard itself is unchanged (same split-screen layout); AuthGate
 * wraps it so only signed-in users see it. Backend authorization is
 * independent of this guard.
 */
function Dashboard() {
  return (
    <main className="h-dvh w-full overflow-hidden bg-slate-100">
      <div className="mx-auto flex h-full max-w-7xl flex-col lg:flex-row">
        {/* ------------------------------------------------------------------
            LEFT PANE — AI Chat (~35% width on large screens)
            ------------------------------------------------------------------ */}
        <section
          aria-label="AI chat"
          className="flex h-[45vh] w-full shrink-0 flex-col border-b border-slate-200 bg-white lg:h-full lg:w-[35%] lg:border-b-0 lg:border-r"
        >
          {/* Chat header */}
          <header className="flex items-center gap-3 border-b border-slate-200 px-4 py-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-900 text-white">
              <Bot className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold text-slate-900">
                TaskMate
              </h1>
              <p className="flex items-center gap-1.5 text-xs text-slate-500">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
                AI Assistant
              </p>
            </div>
            <AccountMenu />
          </header>

          {/* Scrollable message list */}
          <ChatContainer />

          {/* Chat error banner (if any) */}
          <ChatErrorBanner />

          {/* Message composer */}
          <ChatInput />
        </section>

        {/* ------------------------------------------------------------------
            RIGHT PANE — Kanban Board (~65% width on large screens)
            ------------------------------------------------------------------ */}
        <section
          aria-label="Task board"
          className="flex min-h-0 flex-1 flex-col bg-slate-50"
        >
          {/* Board header */}
          <header className="flex items-center gap-2 border-b border-slate-200 bg-white px-6 py-3">
            <ListTodo className="h-5 w-5 text-slate-700" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-slate-900">My Tasks</h2>
          </header>

          {/* Board content */}
          <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
            {/* Email reminders — kept visually separate from due dates. */}
            <ReminderPanel />
            {/* Long-term memory dashboard (Milestone 4). */}
            <MemoryPanel />
            <KanbanBoard />
          </div>
        </section>
      </div>
    </main>
  );
}

/**
 * Route entry: dashboard behind the auth guard. Unauthenticated visitors
 * are redirected to /login; the existing dashboard UI is untouched.
 */
export default function HomePage() {
  return (
    <AuthGate>
      <Dashboard />
    </AuthGate>
  );
}
