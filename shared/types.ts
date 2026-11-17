/**
 * shared/types.ts
 * ---------------
 * Strict TypeScript interfaces mirroring the Supabase database schema.
 * These types are shared between the backend server and any frontend client.
 */

// ---------------------------------------------------------------------------
// Enumerations (mirror the SQL ENUM types)
// ---------------------------------------------------------------------------

/** Lifecycle status of a task. Mirrors SQL type `task_status`. */
export type TaskStatus = 'todo' | 'in_progress' | 'done';

/** Priority level of a task. Mirrors SQL type `task_priority`. */
export type TaskPriority = 'low' | 'medium' | 'high';

/** Role of a chat participant. Mirrors SQL type `message_role`. */
export type MessageRole = 'user' | 'assistant' | 'system';

/**
 * Delivery lifecycle of a reminder. Mirrors SQL type `reminder_status`
 * (Milestone 2).
 * - `pending`   → due, waiting for a background worker to claim it
 * - `claimed`   → picked up by exactly one worker (in flight)
 * - `sent`      → the email provider confirmed delivery
 * - `failed`    → attempt budget exhausted or permanent provider error
 * - `cancelled` → the owner cancelled it before delivery
 */
export type ReminderStatus = 'pending' | 'claimed' | 'sent' | 'failed' | 'cancelled';

// ---------------------------------------------------------------------------
// Database row interfaces
// ---------------------------------------------------------------------------

/** A row in the `users` table. */
export interface User {
  /** Unique identifier (uuid). */
  id: string;
  /** Unique email address. */
  email: string;
  /** Timestamp of account creation. */
  created_at: string;
}

/** A row in the `tasks` table. */
export interface Task {
  /** Unique identifier (uuid). */
  id: string;
  /** Foreign key to `users.id`. */
  user_id: string;
  /** Human-readable task title. */
  title: string;
  /** Current lifecycle status. Defaults to `'todo'`. */
  status: TaskStatus;
  /** Priority level. Defaults to `'medium'`. */
  priority: TaskPriority;
  /** Optional ISO-8601 deadline. `null` when unset. */
  due_date: string | null;
  /** Timestamp of task creation. */
  created_at: string;
}

/** A row in the `messages` table. */
export interface Message {
  /** Unique identifier (uuid). */
  id: string;
  /** Foreign key to `users.id`. */
  user_id: string;
  /** Who authored the message. */
  role: MessageRole;
  /** Plain-text message content. */
  content: string;
  /** Timestamp of message creation. */
  created_at: string;
}

/**
 * A row in the `reminders` table (Milestone 2).
 * NOTE: `reminder_at` is deliberately independent of `Task.due_date` —
 * a task may exist with no reminder, and a reminder may have no task.
 */
export interface Reminder {
  /** Unique identifier (uuid). */
  id: string;
  /** Foreign key to `users.id` — the owner. */
  user_id: string;
  /** Optional foreign key to `tasks.id` (`null` when standalone). */
  task_id: string | null;
  /** Snapshot of what to remind about (usually the task title). */
  title: string;
  /** Delivery timestamp (UTC instant; display in Asia/Kolkata). */
  reminder_at: string;
  /** Delivery lifecycle status. */
  status: ReminderStatus;
  /** Attempts consumed so far (incremented at claim time). */
  attempts: number;
  /** Retry budget for this reminder. */
  max_attempts: number;
  /** Earliest time a worker may (re)claim this reminder. */
  next_attempt_at: string;
  /** When the most recent delivery attempt started. */
  last_attempt_at: string | null;
  /** When the provider confirmed delivery (`null` until sent). */
  sent_at: string | null;
  /** When the reminder permanently failed. */
  failed_at: string | null;
  /** Last failure reason (visible to the owner in the UI). */
  failure_reason: string | null;
  /** Current claim timestamp (used for crash recovery). */
  claimed_at: string | null;
  /** Optional idempotency key supplied at creation. */
  idempotency_key: string | null;
  /** Timestamp of creation. */
  created_at: string;
  /** Timestamp of the last update. */
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Request / response DTOs
// ---------------------------------------------------------------------------

/** Payload accepted by `POST /api/tasks`. */
export interface CreateTaskInput {
  title: string;
  priority?: TaskPriority;
  status?: TaskStatus;
  due_date?: string | null;
}

/** Payload accepted by `PUT /api/tasks/:id` — every field optional. */
export interface UpdateTaskInput {
  title?: string;
  priority?: TaskPriority;
  status?: TaskStatus;
  due_date?: string | null;
}

/**
 * Payload accepted by `POST /api/reminders`.
 * Ownership (`user_id`) is NEVER accepted — it comes from the verified
 * bearer token server-side.
 */
export interface CreateReminderInput {
  /** What to remind about (task title or free text). */
  title: string;
  /** Optional task to attach to; the reminder survives task deletion. */
  task_id?: string | null;
  /** ISO-8601 delivery timestamp (must be in the future). */
  reminder_at: string;
  /** Optional idempotency key — repeated posts with the same key return the existing reminder. */
  idempotency_key?: string | null;
}

/** Payload accepted by `PUT /api/reminders/:id` — only pending reminders may be edited. */
export interface UpdateReminderInput {
  /** New ISO-8601 delivery timestamp (must be in the future). */
  reminder_at: string;
}

/**
 * Verified identity attached to an authenticated request.
 * Produced exclusively by the backend auth middleware after a trusted
 * Supabase Auth token check — never from request input.
 */
export interface AuthIdentity {
  /** Authenticated user's uuid (`auth.users.id` == `public.users.id`). */
  userId: string;
  /** Authenticated user's email, when present. */
  email?: string;
  /**
   * Auth provider as reported by the VERIFIED auth server
   * (`app_metadata.provider` on the GoTrue user), normalized to this
   * application's known values. Used only as a default when self-healing
   * a missing profile row — never accepted from client input.
   */
  provider?: AuthProvider;
}

// ---------------------------------------------------------------------------
// Profile & integrations (Milestone 3 — Google auth / multi-user security)
// ---------------------------------------------------------------------------

/** How the account authenticates. Mirrors `public.users.provider`. */
export type AuthProvider = 'email' | 'google';

/**
 * The signed-in user's application profile (row in `public.users`).
 * Email/provider come from verified auth data — clients cannot set them.
 */
export interface UserProfile {
  /** `auth.users.id` == `public.users.id`. */
  id: string;
  /** Email from the verified account. */
  email: string;
  /** Authentication provider for this account ('email' | 'google'). */
  provider: AuthProvider;
  /** Display name chosen by the user (null when unset). */
  display_name: string | null;
  /** Profile picture URL supplied by the auth provider (null when absent). */
  avatar_url: string | null;
  /** Row creation timestamp; null only in the self-heal fallback shape. */
  created_at: string | null;
}

/**
 * A recorded, EXPLICIT authorization for additional (non-login) Google
 * scopes. See shared/auth.ts: login never reads these; no Gmail/Calendar
 * API is called with them yet.
 */
export interface IntegrationGrant {
  /** Integration identifier (currently only 'google'). */
  integration: string;
  /** Extra scopes the user explicitly authorized (empty when revoked). */
  scopes: string[];
  /** When the grant was last given. */
  granted_at: string;
  /** When the grant was revoked (null while active). */
  revoked_at: string | null;
}

/** Wrapper returned by `GET /api/me`. */
export interface MeResponse {
  user: UserProfile;
}

/** Wrapper returned by `GET /api/integrations`. */
export interface IntegrationsResponse {
  integrations: IntegrationGrant[];
}

/** Wrapper returned by `POST/DELETE /api/integrations`. */
export interface IntegrationResponse {
  integration: IntegrationGrant;
}

/**
 * Payload accepted by `POST /api/chat`.
 *
 * SECURITY: contains no identity fields — the server derives the user from
 * the bearer token and loads conversation history from the database.
 */
export interface ChatRequest {
  /** The latest user utterance. */
  message: string;
  /**
   * Optional Knowledge Base scope: ask about these documents only.
   * Server-verified against the caller's own READY documents; ids that
   * are not owned are ignored, never fetched.
   */
  document_ids?: string[];
  /**
   * Force Knowledge Base retrieval even when the message has no obvious
   * document cue. Still scoped to the caller's own documents.
   */
  use_documents?: boolean;
}

/**
 * One resolvable citation returned with a chat reply.
 *
 * Only markers that map to a real retrieved chunk of a still-owned,
 * still-existing document are returned. Markers the model invents are
 * dropped server-side and never become sources.
 */
export interface DocumentSource {
  /** Citation marker used in the reply, e.g. "S1". */
  marker: string;
  document_id: string;
  chunk_id: string;
  /** Original filename (safe to display). */
  filename: string;
  /** PDF page number when the chunk has one; null for DOCX/TXT. */
  page: number | null;
  /** Nearest heading/section title when available. */
  heading: string | null;
  similarity: number;
}

/** Successful response returned by `POST /api/chat`. */
export interface ChatResponse {
  /** The assistant's reply text. */
  reply: string;
  /** AI provider model that produced the reply (e.g. gemini-3.8-flash). */
  model: string;
  /** Token usage reported by the AI provider. */
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  /** Resolvable document citations (Knowledge Base answers only). */
  sources?: DocumentSource[];
  /** True when document chunks were actually supplied to the model. */
  document_context_used?: boolean;
}

/** Standard error envelope returned by all failing endpoints. */
export interface ApiError {
  error: string;
  details?: unknown;
}

// ---------------------------------------------------------------------------
// Memory (Milestone 4)
// ---------------------------------------------------------------------------

/** Memory categories (mirrors the `memory_category` enum in 0005). */
export type MemoryCategory =
  | 'personal_fact'
  | 'user_preference'
  | 'career_goal'
  | 'project'
  | 'important_event'
  | 'learning_preference'
  | 'work_info'
  | 'recurring_info'
  | 'other';

/** Memory lifecycle status (mirrors the CHECK constraint in 0005). */
export type MemoryStatus =
  | 'active'
  | 'needs_review'
  | 'superseded'
  | 'expired'
  | 'deleted';

/** Privacy classification of a stored memory. */
export type MemorySensitivity = 'normal' | 'sensitive' | 'credential';

/** A stored long-term memory (server-rendered; never contains embeddings). */
export interface Memory {
  id: string;
  user_id: string;
  content: string;
  content_summary: string | null;
  category: MemoryCategory;
  embedding_provider: string;
  embedding_model_version: string;
  embedding_dimensions: number;
  source_message_id: string | null;
  source_evidence: string | null;
  confidence: 'low' | 'medium' | 'high';
  status: MemoryStatus;
  superseded_by: string | null;
  supersession_confirmed_by_user: boolean;
  /** For needs_review rows: the existing memory this row contradicts. */
  conflict_with: string | null;
  sensitivity: MemorySensitivity;
  extraction_timestamp: string;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
  expired_at: string | null;
}

/** One ranked hit from `match_memories` (similarity in [0, 1]). */
export interface MemorySearchHit {
  id: string;
  content: string;
  category: MemoryCategory;
  similarity: number;
  created_at: string;
}

/** Response for `POST /api/memories/search`. */
export interface MemorySearchResponse {
  memories: MemorySearchHit[];
  count: number;
}

/** Per-user memory settings (user-controlled consent). */
export interface MemorySettings {
  user_id: string;
  automatic_memory_extraction: boolean;
  similarity_threshold: number;
  include_memory_in_chat: boolean;
  include_sensitive_in_chat: boolean;
  max_memory_context_chars: number;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Knowledge Base (Milestone 5)
// ---------------------------------------------------------------------------

/** Lifecycle of an uploaded document (mirrors the CHECK in 0011). */
export type DocumentStatus =
  | 'uploaded'
  | 'pending'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'deleting'
  | 'deleted';

/** Supported upload formats. */
export type DocumentExtension = 'pdf' | 'docx' | 'txt';

/** Server-detected MIME type (the browser value is never trusted). */
export type DocumentMimeType =
  | 'application/pdf'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  | 'text/plain';

/**
 * Non-sensitive extraction facts recorded by the worker.
 * `scanned` is true only for PDFs with too little extractable text; those
 * fail with `SCANNED_PDF_REQUIRES_OCR` because no OCR is implemented.
 */
export interface DocumentExtractionMetadata {
  encoding?: string;
  scanned?: boolean;
  paragraphs?: number;
  headings?: number;
  tables?: number;
  pages_with_text?: number;
  truncated?: boolean;
}

/**
 * A document as exposed by the API.
 *
 * SECURITY: deliberately excludes `storage_path` and `storage_filename`.
 * Object locations are server-side only and are never sent to clients.
 */
export interface KnowledgeDocument {
  id: string;
  original_filename: string;
  extension: DocumentExtension;
  mime_type: DocumentMimeType;
  file_size: number;
  content_hash: string;
  status: DocumentStatus;
  page_count: number | null;
  text_char_count: number | null;
  chunk_count: number;
  extraction_metadata: DocumentExtractionMetadata;
  error_message: string | null;
  processing_started_at: string | null;
  processing_completed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Queue state attached to a document detail response. */
export interface DocumentJobInfo {
  status: 'pending' | 'claimed' | 'completed' | 'failed';
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  failed_at: string | null;
  error_message: string | null;
}

/** Response for `GET /api/documents/:id`. */
export interface DocumentDetailsResponse {
  document: KnowledgeDocument;
  job: DocumentJobInfo | null;
}

/** Response for `GET /api/documents`. */
export interface DocumentListResponse {
  documents: KnowledgeDocument[];
  count: number;
}

/** Response for `POST /api/documents` (201). */
export interface DocumentUploadResponse {
  document: KnowledgeDocument;
}

/** Response body for a 409 duplicate upload. */
export interface DuplicateDocumentError {
  error: string;
  existing_document_id: string;
}

/** One chunk preview shown in the document detail panel. */
export interface DocumentChunkPreview {
  id: string;
  chunk_index: number;
  page_start: number | null;
  page_end: number | null;
  heading: string | null;
  section_path: string | null;
  paragraph_start: number | null;
  paragraph_end: number | null;
  char_start: number | null;
  char_end: number | null;
  token_estimate: number | null;
  /** Truncated text for display; full text is never sent in list views. */
  preview: string;
}

/** Response for `GET /api/documents/:id/chunks`. */
export interface DocumentChunkListResponse {
  chunks: DocumentChunkPreview[];
  count: number;
}

/** One semantic search hit from `POST /api/documents/search`. */
export interface DocumentSearchHit {
  chunk_id: string;
  document_id: string;
  filename: string;
  chunk_index: number;
  page_start: number | null;
  page_end: number | null;
  heading: string | null;
  section_path: string | null;
  paragraph_start: number | null;
  paragraph_end: number | null;
  similarity: number;
  preview: string;
}

/** Response for `POST /api/documents/search`. */
export interface DocumentSearchResponse {
  chunks: DocumentSearchHit[];
  count: number;
}

/** Response for `GET /api/documents/:id/view`. */
export interface DocumentViewResponse {
  /** Short-lived signed URL, or an authenticated content route in local mode. */
  url: string;
  extension: DocumentExtension;
  page_count: number | null;
  /** Signed-URL lifetime in seconds (0 for the local content route). */
  expires_in: number;
}
