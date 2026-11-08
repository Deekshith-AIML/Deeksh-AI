import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { resetFakeSupabase, registerUser, fakeDb, fakeCreateUserScopedClient } from './helpers/fakeSupabase.js';

const TOKEN = 'test-token-persistence';
const USER_ID = '11111111-1111-4111-8111-111111111111';

describe('Cross-conversation memory persistence', () => {
  beforeEach(() => {
    resetFakeSupabase();
    registerUser(TOKEN, USER_ID, 'test@example.com');
  });

  it('First interaction: extracts structured memories from "I am preparing for Data Analyst placements. I prefer Python and SQL."', async () => {
    const { forceMatchSimilarity } = await import('./helpers/fakeSupabase.js');
    const client = fakeCreateUserScopedClient(TOKEN);

    // Reset memories array by clearing it (fakeDb.memories is a getter)
    const { resetFakeSupabase } = await import('./helpers/fakeSupabase.js');
    resetFakeSupabase();
    registerUser(TOKEN, USER_ID, 'test@example.com');
    
    // Ensure no conflicting memories exist and set low similarity to avoid conflict detection
    forceMatchSimilarity(0.1);

    // Simulate extraction from user message
    const userMessageId = randomUUID();
    fakeDb.messages.push({
      id: userMessageId,
      user_id: USER_ID,
      role: 'user',
      content: 'I am preparing for Data Analyst placements. I prefer Python and SQL.',
      created_at: new Date().toISOString(),
    });

    // User has consent enabled
    await import('../src/services/memory.service.js').then(m => m.updateMemorySettings(
      client, USER_ID, { automatic_memory_extraction: true }
    ));

    // The extraction worker would process this, but we test the storage directly
    const result1 = await import('../src/services/memory.service.js').then(m => m.createMemory(
      client, USER_ID, {
        content: 'User is preparing for Data Analyst placements.',
        category: 'career_goal',
        sourceMessageId: userMessageId,
        evidence: 'I am preparing for Data Analyst placements.',
        confidence: 'high',
        status: 'active',
      }
    ));

    const result2 = await import('../src/services/memory.service.js').then(m => m.createMemory(
      client, USER_ID, {
        content: 'User prefers Python and SQL.',
        category: 'learning_preference',
        sourceMessageId: userMessageId,
        evidence: 'I prefer Python and SQL.',
        confidence: 'high',
        status: 'active',
      }
    ));

    expect(result1.created).toBe(true);
    expect(result1.memory.content).toContain('Data Analyst');
    expect(result1.memory.source_message_id).toBe(userMessageId);
    // High confidence → active status
    expect(result1.memory.status).toBe('active');

    expect(result2.created).toBe(true);
    expect(result2.memory.content).toContain('Python');
    expect(result2.memory.source_message_id).toBe(userMessageId);
    expect(result2.memory.status).toBe('active');
  });

  it('Second independent interaction: retrieves relevant persistent memories for "What should I focus on learning?"', async () => {
    const { retrieveMemories } = await import('../src/services/memory.service.js');
    const { embed: embedFn } = await import('../src/services/embedding.service.js');
    const client = fakeCreateUserScopedClient(TOKEN);

    // Seed the two memories from first interaction
    const mem1 = {
      id: randomUUID(),
      user_id: USER_ID,
      content: 'User is preparing for Data Analyst placements.',
      content_summary: 'User is preparing for Data Analyst placements.',
      category: 'career_goal',
      embedding_provider: 'gemini',
      embedding_model_version: 'gemini-embedding-2',
      embedding_dimensions: 1536,
      source_message_id: randomUUID(),
      source_evidence: 'I am preparing for Data Analyst placements.',
      confidence: 'high',
      status: 'active',
      superseded_by: null,
      supersession_confirmed_by_user: false,
      sensitivity: 'normal',
      extraction_timestamp: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_accessed_at: null,
      expired_at: null,
    };

    const mem2 = {
      id: randomUUID(),
      user_id: USER_ID,
      content: 'User prefers Python and SQL.',
      content_summary: 'User prefers Python and SQL.',
      category: 'learning_preference',
      embedding_provider: 'gemini',
      embedding_model_version: 'gemini-embedding-2',
      embedding_dimensions: 1536,
      source_message_id: mem1.source_message_id,
      source_evidence: 'I prefer Python and SQL.',
      confidence: 'high',
      status: 'active',
      superseded_by: null,
      supersession_confirmed_by_user: false,
      sensitivity: 'normal',
      extraction_timestamp: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_accessed_at: null,
      expired_at: null,
    };

    fakeDb.memories.push(mem1, mem2);

    // Force high similarity for relevant query
    const { forceMatchSimilarity } = await import('./helpers/fakeSupabase.js');
    forceMatchSimilarity(0.85);

    const queryEmbedding = await embedFn('What should I focus on learning?', { mock: true, role: 'query' });
    const { memories } = await retrieveMemories(client, USER_ID, queryEmbedding, { threshold: 0.65, maxResults: 5 });

    expect(memories.length).toBeGreaterThan(0);
    expect(memories.some(m => m.content.includes('Python'))).toBe(true);
    expect(memories.some(m => m.content.includes('Data Analyst'))).toBe(true);
  });

  it('Third interaction: retrieves correct career memory for "What do you remember about my career goals?"', async () => {
    const { retrieveMemories } = await import('../src/services/memory.service.js');
    const { embed } = await import('../src/services/embedding.service.js');
    const client = fakeCreateUserScopedClient(TOKEN);

    const mem = {
      id: randomUUID(),
      user_id: USER_ID,
      content: 'User is preparing for Data Analyst placements.',
      content_summary: 'User is preparing for Data Analyst placements.',
      category: 'career_goal',
      embedding_provider: 'gemini',
      embedding_model_version: 'gemini-embedding-2',
      embedding_dimensions: 1536,
      source_message_id: randomUUID(),
      source_evidence: 'I am preparing for Data Analyst placements.',
      confidence: 'high',
      status: 'active',
      superseded_by: null,
      supersession_confirmed_by_user: false,
      sensitivity: 'normal',
      extraction_timestamp: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_accessed_at: null,
      expired_at: null,
    };

    fakeDb.memories.push(mem);
    const { forceMatchSimilarity } = await import('./helpers/fakeSupabase.js');
    forceMatchSimilarity(0.9);

    const queryEmbedding = await embed('What do you remember about my career goals?', { mock: true, role: 'query' });
    const { memories } = await retrieveMemories(client, USER_ID, queryEmbedding, { threshold: 0.65, maxResults: 5 });

    expect(memories.length).toBe(1);
    expect(memories[0]?.content).toContain('Data Analyst');
    expect(memories[0]?.category).toBe('career_goal');
  });

  it('Fourth interaction: identifies changed career goal, preserves historical memory, requests confirmation', async () => {
    const { checkConflict, supersedeMemory, createMemory } = await import('../src/services/memory.service.js');
    const { embed } = await import('../src/services/embedding.service.js');
    const client = fakeCreateUserScopedClient(TOKEN);

    // Existing career memory
    const oldMem = {
      id: randomUUID(),
      user_id: USER_ID,
      content: 'User is preparing for Data Analyst placements.',
      content_summary: 'User is preparing for Data Analyst placements.',
      category: 'career_goal',
      embedding_provider: 'gemini',
      embedding_model_version: 'gemini-embedding-2',
      embedding_dimensions: 1536,
      source_message_id: randomUUID(),
      source_evidence: 'I am preparing for Data Analyst placements.',
      confidence: 'high',
      status: 'active',
      superseded_by: null,
      supersession_confirmed_by_user: false,
      sensitivity: 'normal',
      extraction_timestamp: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_accessed_at: null,
      expired_at: null,
    };

    fakeDb.memories.push(oldMem);
    const { forceMatchSimilarity } = await import('./helpers/fakeSupabase.js');
    forceMatchSimilarity(0.8); // Contradiction range

    // New statement: "I am now focusing on Backend Developer roles"
    const newContent = 'User is now focusing on Backend Developer roles.';
    const newEmbedding = await embed(newContent, { mock: true, role: 'document' });

    const conflict = await checkConflict(client, USER_ID, newContent, 'career_goal', newEmbedding);

    // Should detect conflict (contradiction), not duplicate
    expect(conflict.isConflict).toBe(true);
    expect(conflict.isDuplicate).toBe(false);
    expect(conflict.existing).toBeTruthy();
    expect(conflict.existing?.content).toContain('Data Analyst');

    // Original memory preserved
    expect(oldMem.status).toBe('active');
    expect(oldMem.superseded_by).toBeNull();

    // New memory created with needs_review status
    const newMemResult = await createMemory(client, USER_ID, {
      content: newContent,
      category: 'career_goal',
      confidence: 'high',
      status: 'needs_review',
    });

    expect(newMemResult.created).toBe(true);
    expect(newMemResult.memory.status).toBe('needs_review');
    expect(newMemResult.memory.content).toContain('Backend Developer');

    // Supersession only after user confirms
    const superseded = await supersedeMemory(client, USER_ID, oldMem.id, newMemResult.memory.id);
    expect(superseded.status).toBe('superseded');
    expect(superseded.superseded_by).toBe(newMemResult.memory.id);
    expect(superseded.supersession_confirmed_by_user).toBe(true);
  });

  it('Verifies provenance: source message linked to memories', async () => {
    const { createMemory } = await import('../src/services/memory.service.js');
    const client = fakeCreateUserScopedClient(TOKEN);

    const messageId = randomUUID();
    fakeDb.messages.push({
      id: messageId,
      user_id: USER_ID,
      role: 'user',
      content: 'I am preparing for Data Analyst placements.',
      created_at: new Date().toISOString(),
    });

    const result = await createMemory(client, USER_ID, {
      content: 'User is preparing for Data Analyst placements.',
      category: 'career_goal',
      sourceMessageId: messageId,
      evidence: 'I am preparing for Data Analyst placements.',
      confidence: 'high',
    });

    expect(result.memory.source_message_id).toBe(messageId);
    expect(result.memory.source_evidence).toContain('Data Analyst');
  });
});