/**
 * src/components/chat/ChatContainer.tsx
 * ------------------------------------
 * Scrollable message list.
 * - Auto-scrolls to the newest message whenever the list changes.
 * - Shows a friendly empty state when there are no messages yet.
 */

'use client';

import { useEffect, useRef } from 'react';
import { MessageSquare } from 'lucide-react';
import { useChatStore } from '@/store/useChatStore';
import ChatBubble from './ChatBubble';

export function ChatContainer() {
  const messages = useChatStore((state) => state.messages);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Scroll the latest message into view whenever messages update.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  // Empty state — invite the user to try a natural-language task request.
  if (messages.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100">
          <MessageSquare className="h-7 w-7 text-slate-400" aria-hidden="true" />
        </div>
        <h2 className="text-sm font-semibold text-slate-700">Start a conversation</h2>
        <p className="mt-1 max-w-xs text-xs leading-relaxed text-slate-400">
          Ask me to create tasks, e.g. “Remind me to buy groceries tomorrow at high priority”.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 space-y-4 overflow-y-auto px-4 py-6">
      {messages.map((message) => (
        <ChatBubble key={message.id} message={message} />
      ))}
      {/* Anchor element for auto-scroll. */}
      <div ref={bottomRef} />
    </div>
  );
}

export default ChatContainer;
