/**
 * client/src/app/documents/[id]/page.tsx
 * -------------------------------------
 * Citation/document viewer route.
 *
 * The server component parses query parameters defensively (no
 * `useSearchParams` Suspense requirement) and renders the authenticated
 * client viewer. Authorization is enforced by the backend on every request.
 */

import AuthGate from '@/components/auth/AuthGate';
import DocumentViewer from '@/components/documents/DocumentViewer';
import { parseDocumentViewerTarget } from '../../../../../shared/citation-link';

interface DocumentPageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function DocumentPage({ params, searchParams }: DocumentPageProps) {
  const { id } = await params;
  const raw = await searchParams;
  const target = parseDocumentViewerTarget({
    page: raw.page ?? null,
    chunk: raw.chunk ?? null,
    heading: raw.heading ?? null,
  });

  return (
    <AuthGate>
      <DocumentViewer documentId={id} target={target} />
    </AuthGate>
  );
}
