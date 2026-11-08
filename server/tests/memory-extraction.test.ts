/**
 * tests/memory-extraction.test.ts
 * ---------------------------------
 * Milestone 4.1 — Task C structured extraction. Verifies the Zod-validated
 * LLM output pipeline (credential/sensitive filtering, dedupe, verbatim-evidence
 * verification, confidence handling) — all offline (no live API).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  extractFacts,
  toCandidates,
  ExtractionError,
  extractionFactSchema,
  extractionOutputSchema,
  MAX_EXTRACTION_ATTEMPTS,
  MAX_EXTRACTED_FACTS,
} from '../src/services/extraction.service.js';
import { looksLikeCredential, looksSensitive } from '../src/services/credential.guard.js';

beforeEach(() => {
  process.env.NODE_ENV = 'test';
});

describe('extractionFactSchema', () => {
  it('accepts a high-confidence fact with evidence', () => {
    const parsed = extractionOutputSchema.safeParse({
      facts: [{ content: 'User prefers Python.', category: 'user_preference', evidence: 'I prefer Python.', confidence: 'high' }],
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts missing evidence (defaults to empty string)', () => {
    const parsed = extractionOutputSchema.safeParse({
      facts: [{ content: 'I enjoy hiking.', category: 'personal_fact', confidence: 'medium' }],
    });
    expect(parsed.success).toBe(true);
  });

  it('allows unknown categories that coerce to "other"', () => {
    const unknownCat = [{ content: 'X', category: 'not_a_real_category', confidence: 'high' }];
    const parsed = extractionOutputSchema.safeParse({ facts: unknownCat });
    // z.enum rejects unknown categories; .catch('other') makes them valid.
    expect(parsed.success).toBe(true);
    expect(parsed.data!.facts[0]!.category).toBe('other');
  });

  it('rejects facts exceeding MAX_EXTRACTED_FACTS (10)', () => {
    const tooMany = Array.from({ length: MAX_EXTRACTED_FACTS + 5 }, () => ({ content: 'x', category: 'other', confidence: 'high' }));
    const parsed = extractionOutputSchema.safeParse({ facts: tooMany });
    expect(parsed.success).toBe(false);
  });
});

describe('toCandidates filters', () => {
  it('drops credential-shaped facts entirely', () => {
    const out = toCandidates(
      { facts: [
        { content: 'My API key is sk-secret123', category: 'user_preference', evidence: '', confidence: 'high' },
        { content: 'Normal statement', category: 'personal_fact', evidence: '', confidence: 'high' },
      ] },
      'Some message here.',
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toBe('Normal statement');
  });

  it('drops low-confidence facts (not stored, not surfaced)', () => {
    const out = toCandidates(
      { facts: [
        { content: 'A plain fact', category: 'personal_fact', evidence: '', confidence: 'low' },
        { content: 'B plain fact', category: 'personal_fact', evidence: '', confidence: 'high' },
      ] },
      'Some message here.',
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toBe('B plain fact');
  });

  it('dedupes in-batch exact matches (normalized lowercase whitespace)', () => {
    const out = toCandidates(
      { facts: [
        { content: 'I work at Acme Corp', category: 'work_info', evidence: '', confidence: 'high' },
        { content: '  I work at   Acme Corp  ', category: 'work_info', evidence: '', confidence: 'high' },
      ] },
      'msg',
    );
    expect(out).toHaveLength(1);
  });

  it('keeps sensitive facts but flags them for review (hidden from chat)', () => {
    const out = toCandidates(
      { facts: [
        { content: 'The user takes anxiety medication every day', category: 'learning_preference', evidence: '', confidence: 'high' },
      ] },
      'Some message here.',
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.sensitivity).toBe('sensitive');
    expect(looksSensitive('The user takes anxiety medication every day')).toBe(true);
  });

  it('rejects unverifiable evidence (become null)', () => {
    const out = toCandidates(
      { facts: [
        { content: 'User prefers Python', category: 'user_preference', evidence: 'paraphrased evidence', confidence: 'high' },
      ] },
      'Source says exactly User prefers Python',
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.evidence).toBeNull(); // span was not verbatim
  });

  it('keeps verbatim evidence matches', () => {
    const msg = 'I prefer simple explanations.';
    const out = toCandidates(
      { facts: [
        { content: 'User prefers simple explanations', category: 'learning_preference', evidence: 'I prefer simple explanations.', confidence: 'high' },
      ] },
      msg,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.evidence).toBe('I prefer simple explanations.'); // verbatim
    expect(msg).toContain('I prefer simple explanations.');
  });

  });

describe('extractFacts', () => {
  it('returns [] for empty input (nothing durable can be stated)', async () => {
    await expect(extractFacts('')).resolves.toEqual([]);
    await expect(extractFacts('   ')).resolves.toEqual([]);
  });

  it('verifies credential rejection at the service layer', () => {
    expect(looksLikeCredential('My password is hunter2')).toBe(true);
    expect(looksLikeCredential('https://example.com/token?x=1')).toBe(false); // no key shape
  });
});

describe('ExtractionError', () => {
  it('is throwable with a typed code', async () => {
    let caught: unknown;
    try {
      throw new ExtractionError('failed', 'INVALID_OUTPUT');
    } catch (err) {
      caught = err;
    }
    expect((caught as ExtractionError).code).toBe('INVALID_OUTPUT');
  });

  it('constants are bounded as documented', () => {
    expect(MAX_EXTRACTION_ATTEMPTS).toBeLessThanOrEqual(2);
    expect(MAX_EXTRACTED_FACTS).toBeLessThanOrEqual(10);
  });
});