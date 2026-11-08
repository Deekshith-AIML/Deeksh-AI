/**
 * src/types.ts
 * ------------
 * Shared TypeScript interfaces mirroring the backend database schema
 * and API contracts. In a monorepo, these would be imported from
 * `shared/types.ts`; they are mirrored here for standalone builds.
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
 * (Milestone 2): pending → claimed → sent | failed, or cancelled by owner.
 */
export type ReminderStatus = 'pending' | 'claimed' | 'sent' | 'failed' | 'cancelled';

// ---------------------------------------------------------------------------
// Database row interfaces
// ---------------------------------------------------------------------------

/** A row in the `users` table. */
export interface User {
  id: string;
  email: string;
  created_at: string;
}

/** A row in the `tasks` table. */
export interface Task {
  id: string;
  user_id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  due_date: string | null;
  created_at: string;
}

/** A row in the `messages` table (server-persisted chat turn). */
export interface Message {
  id: string;
  user_id: string;
  role: MessageRole;
  content: string;
  created_at: string;
}

/**
 * A row in the `reminders` table (Milestone 2).
 * NOTE: `reminder_at` is deliberately independent of `Task.due_date` —
 * reminders are scheduled email notifications, NOT deadlines.
 */
export interface Reminder {
  id: string;
  user_id: string;
  /** Linked task, or null for a standalone reminder. */
  task_id: string | null;
  title: string;
  /** ISO-8601 delivery timestamp (display in the user's local time). */
  reminder_at: string;
  status: ReminderStatus;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  last_attempt_at: string | null;
  sent_at: string | null;
  failed_at: string | null;
  /** Why delivery failed — surfaced in the UI for `failed` reminders. */
  failure_reason: string | null;
  claimed_at: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Client-side chat message (adds optimistic/loading UI state)
// ---------------------------------------------------------------------------

/** A chat bubble as rendered in the UI. Extends the API Message shape. */
export interface ChatMessage {
  /** Local or server-generated identifier used as the React key. */
  id: string;
  role: MessageRole;
  content: string;
  /** ISO-8601 timestamp. */
  created_at?: string;
  /** True while the assistant reply is still being generated. */
  isLoading?: boolean;
}

// ---------------------------------------------------------------------------
// Request / response DTOs (match backend shared/schemas.ts)
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
 * Payload sent to `POST /api/chat`.
 *
 * SECURITY: no identity fields — the server derives the user from the
 * `Authorization: Bearer <access_token>` header and loads conversation
 * history from the database (kept in sync with shared/types.ts).
 */
export interface ChatRequest {
  message: string;
}

/** Successful response returned by `POST /api/chat`. */
export interface ChatResponse {
  reply: string;
  model: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** Standard error envelope returned by failing endpoints. */
export interface ApiError {
  error: string;
  details?: unknown;
}

/** Wrapper returned by `GET /api/tasks`. */
export interface ListTasksResponse {
  tasks: Task[];
}

/** Wrapper returned by `POST /api/tasks` and `PUT /api/tasks/:id`. */
export interface TaskResponse {
  task: Task;
}

// ---------------------------------------------------------------------------
// Reminder DTOs (Milestone 2 — match backend shared/schemas.ts)
// ---------------------------------------------------------------------------

/**
 * Payload sent to `POST /api/reminders`.
 * SECURITY: no identity fields — ownership comes from the bearer token.
 */
export interface CreateReminderInput {
  title: string;
  task_id?: string | null;
  /** ISO-8601 timestamp; must be in the future (server-validated). */
  reminder_at: string;
  idempotency_key?: string | null;
}

/** Payload sent to `PUT /api/reminders/:id` (pending reminders only). */
export interface UpdateReminderInput {
  /** New ISO-8601 timestamp; must be in the future. */
  reminder_at: string;
}

/** Wrapper returned by `GET /api/reminders`. */
export interface ListRemindersResponse {
  reminders: Reminder[];
}

/** Wrapper returned by `POST /api/reminders`. */
export interface CreateReminderResponse {
  reminder: Reminder;
  /** False when an existing reminder was returned via idempotency key. */
  created: boolean;
}

/** Wrapper returned by `GET/PUT/DELETE /api/reminders/:id`. */
export interface ReminderResponse {
  reminder: Reminder;
}

// ---------------------------------------------------------------------------
// Profile & integration DTOs (Milestone 3 — match shared/types.ts)
// ---------------------------------------------------------------------------

/** How the account authenticates. */
export type AuthProvider = 'email' | 'google';

/**
 * The signed-in user's application profile. Email/provider come from
 * verified auth data — clients cannot set them.
 */
export interface UserProfile {
  id: string;
  email: string;
  provider: AuthProvider;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string | null;
}

/** A recorded, EXPLICIT authorization for additional Google scopes. */
export interface IntegrationGrant {
  integration: string;
  scopes: string[];
  granted_at: string;
  revoked_at: string | null;
}

/** Wrapper returned by `GET /api/me` and `PATCH /api/me`. */
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
  created?: boolean;
}

// ---------------------------------------------------------------------------
// Memory DTOs (Milestone 4 — match shared/types.ts)
// ---------------------------------------------------------------------------

/** Memory categories. */
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

/** Memory lifecycle status. */
export type MemoryStatus = 'active' | 'needs_review' | 'superseded' | 'expired' | 'deleted';

/** Privacy classification of a stored memory. */
export type MemorySensitivity = 'normal' | 'sensitive' | 'credential';

/** A stored long-term memory (never contains embeddings). */
export interface Memory {
  id: string;
  content: string;
  content_summary: string | null;
  category: MemoryCategory;
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
  expired_at: string | null;
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

/** Wrapper returned by `GET /api/memories`. */
export interface MemoryListResponse {
  memories: Memory[];
}

/** Wrapper returned by `GET/PATCH /api/memories/settings`. */
export interface MemorySettingsResponse {
  settings: MemorySettings;
}

/** Payload for `POST /api/memories` (no user_id — identity is the token). */
export interface CreateMemoryInput {
  content: string;
  category?: MemoryCategory;
  source_message_id?: string | null;
  source_evidence?: string;
  confidence?: 'low' | 'medium' | 'high';
  sensitivity?: 'normal' | 'sensitive';
}
