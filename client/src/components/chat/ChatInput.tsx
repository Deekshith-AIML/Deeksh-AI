/**
 * src/components/chat/ChatInput.tsx
 * ---------------------------------
 * Message composer pinned to the bottom of the chat pane.
 * - Enter or the Send button submits the message.
 * - Input and button are disabled while an assistant reply is pending.
 */

'use client';

import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { Send } from 'lucide-react';
import { useChatStore } from '@/store/useChatStore';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';

export function ChatInput() {
  const [value, setValue] = useState('');
  const sendMessage = useChatStore((state) => state.sendMessage);
  const isLoading = useChatStore((state) => state.isLoading);

  const canSend = value.trim().length > 0 && !isLoading;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSend) return;

    const text = value;
    setValue(''); // Clear immediately for a snappy feel.
    await sendMessage(text);
  };

  // Allow Enter to submit, Shift+Enter for a newline.
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      // Trigger the form submit programmatically.
      event.currentTarget.form?.requestSubmit();
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="flex items-center gap-2 border-t border-slate-200 bg-white p-4"
    >
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Type a message…"
        disabled={isLoading}
        aria-label="Chat message"
        className="flex-1"
      />
      <Button
        type="submit"
        size="icon"
        disabled={!canSend}
        isLoading={isLoading}
        aria-label="Send message"
      >
        <Send className="h-4 w-4" aria-hidden="true" />
      </Button>
    </form>
  );
}

export default ChatInput;
