/**
 * src/app/layout.tsx
 * ------------------
 * Root layout for the Next.js App Router.
 * Wraps every page with <html>, <body>, global CSS, and metadata.
 */

import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'TaskMate — AI Task Assistant',
    template: '%s | TaskMate',
  },
  description:
    'Chat with an AI assistant to create, organize, and complete your tasks on a live Kanban board.',
  keywords: ['AI', 'task management', 'chatbot', 'kanban', 'assistant'],
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0f172a',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="font-sans">{children}</body>
    </html>
  );
}
