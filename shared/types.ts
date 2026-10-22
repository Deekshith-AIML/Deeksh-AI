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
 * Verified identity attached to an authenticated request.
 * Produced exclusively by the backend auth middleware after a trusted
 * Supabase Auth token check — never from request input.
 */
export interface AuthIdentity {
  /** Authenticated user's uuid (`auth.users.id` == `public.users.id`). */
  userId: string;
  /** Authenticated user's email, when present. */
  email?: string;
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
}

/** Successful response returned by `POST /api/chat`. */
export interface ChatResponse {
  /** The assistant's reply text. */
  reply: string;
  /** OpenAI model that produced the reply. */
  model: string;
  /** Token usage reported by the OpenAI API. */
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** Standard error envelope returned by all failing endpoints. */
export interface ApiError {
  error: string;
  details?: unknown;
}
