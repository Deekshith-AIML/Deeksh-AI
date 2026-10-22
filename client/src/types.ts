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
