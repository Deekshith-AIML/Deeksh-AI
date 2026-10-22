/**
 * src/components/chat/ChatBubble.tsx
 * ---------------------------------
 * Renders a single chat message.
 * - User messages: right-aligned, dark bubble, user avatar.
 * - Assistant messages: left-aligned, light bubble, bot avatar.
 * - While `isLoading` is true, renders an animated typing indicator.
 */

'use client';

import { Bot, User } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ChatMessage } from '@/types';

interface ChatBubbleProps {
  message: ChatMessage;
}

/** Three bouncing dots shown while the assistant reply is pending. */
function TypingIndicator() {
  return (
    <div className="flex items-center gap-1 py-1" aria-label="Assistant is typing">
      <span className="h-2 w-2 animate-bounce rounded-full bg-slate-400 [animation-delay:-0.3s]" />
      <span className="h-2 w-2 animate-bounce rounded-full bg-slate-400 [animation-delay:-0.15s]" />
      <span className="h-2 w-2 animate-bounce rounded-full bg-slate-400" />
    </div>
  );
}

export function ChatBubble({ message }: ChatBubbleProps) {
  const isUser = message.role === 'user';

  return (
    <div
      className={cn(
        'flex w-full items-end gap-2 animate-fade-in',
        isUser ? 'justify-end' : 'justify-start',
      )}
    >
      {/* Assistant avatar (left) */}
      {!isUser && (
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-900 text-white">
          <Bot className="h-4 w-4" aria-hidden="true" />
        </div>
      )}

      {/* Message bubble */}
      <div
        className={cn(
          'max-w-[80%] px-4 py-2.5 text-sm leading-relaxed',
          isUser
            ? 'rounded-2xl rounded-br-md bg-slate-900 text-white'
            : 'rounded-2xl rounded-bl-md bg-slate-100 text-slate-900',
        )}
      >
        {message.isLoading ? (
          <TypingIndicator />
        ) : (
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        )}
      </div>

      {/* User avatar (right) */}
      {isUser && (
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-200 text-slate-700">
          <User className="h-4 w-4" aria-hidden="true" />
        </div>
      )}
    </div>
  );
}

export default ChatBubble;
