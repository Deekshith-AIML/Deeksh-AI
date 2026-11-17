import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import {
  preflightDocx,
  looksLikeZip,
} from '../src/services/documents/validation.js';
import {
  inspectDocxZip,
  DOCX_REQUIRED_ENTRIES,
} from '../src/services/documents/docx.zip.js';
import type { DocxZipEntry } from '../src/services/documents/docx.zip.js';
import { getDocumentsConfig } from '../src/config/documents.config.js';

const config = getDocumentsConfig();

/** Minimal set of OOXML parts required by the preflight. */
function requiredParts(): Record<string, string> {
  return {
    '[Content_Types].xml': '<Types/>',
    '_rels/.rels': '<Relationships/>',
    'word/document.xml': '<w:document/>',
  };
}

async function makeZip(
  files: Record<string, string>,
  compression: 'STORE' | 'DEFLATE' = 'DEFLATE',
): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content);
  }
  return zip.generateAsync({
    type: 'nodebuffer',
    compression,
    compressionOptions: { level: 9 },
  });
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  for (let offset = bytes.length - 22; offset >= 0; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error('EOCD not found in test fixture');
}

function firstCentralDirectoryEntry(bytes: Buffer): number {
  const eocd = findEndOfCentralDirectory(bytes);
  return bytes.readUInt32LE(eocd + 16);
}

function centralDirectoryEntries(bytes: Buffer): number[] {
  const eocd = findEndOfCentralDirectory(bytes);
  const start = bytes.readUInt32LE(eocd + 16);
  const size = bytes.readUInt32LE(eocd + 12);
  const end = start + size;
  const offsets: number[] = [];
  let cursor = start;

  while (cursor + 46 <= end && bytes.readUInt32LE(cursor) === 0x02014b50) {
    offsets.push(cursor);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return offsets;
}

function expectCode(promise: Promise<void>, code: string): Promise<void> {
  return expect(promise).rejects.toMatchObject({ code });
}

describe('M5 Corrective Patch 2 — DOCX ZIP security', () => {
  it('accepts a valid DOCX package and reports bounded metadata', async () => {
    const bytes = await makeZip(requiredParts());
    expect(looksLikeZip(bytes)).toBe(true);
    await expect(preflightDocx(bytes, config)).resolves.toBeUndefined();

    const inspection = inspectDocxZip(bytes, config);
    // JSZip emits directory records for `word/` and `_rels/` too.
    expect(inspection.entries.length).toBeGreaterThanOrEqual(3);
    expect(inspection.totalUncompressedBytes).toBeGreaterThan(0);

    const names = inspection.entries.map((entry: DocxZipEntry) => entry.name);
    for (const required of DOCX_REQUIRED_ENTRIES) {
      expect(names).toContain(required);
    }
  });

  it('rejects a non-ZIP file', async () => {
    const bytes = Buffer.from('this is definitely not a zip archive');
    await expectCode(preflightDocx(bytes, config), 'MALFORMED_FILE');
  });

  it('rejects a truncated / malformed central directory', async () => {
    const bytes = await makeZip(requiredParts());
    const truncated = bytes.subarray(0, Math.floor(bytes.length / 2));
    await expectCode(preflightDocx(truncated, config), 'MALFORMED_FILE');
  });

  it('rejects an archive with too many entries', async () => {
    const files = {
      ...requiredParts(),
      'word/extra.xml': '<extra/>',
    };
    const bytes = await makeZip(files);
    const strict = { ...config, docxMaxEntries: 3 };
    await expectCode(preflightDocx(bytes, strict), 'DOCX_TOO_MANY_ENTRIES');
  });

  it('rejects an archive whose total uncompressed size is too large', async () => {
    const files = {
      ...requiredParts(),
      'word/large.xml': 'x'.repeat(500),
    };
    const bytes = await makeZip(files);
    const strict = { ...config, docxMaxUncompressedBytes: 100 };
    await expectCode(preflightDocx(bytes, strict), 'DOCX_TOO_LARGE');
  });

  it('rejects a single entry that is too large', async () => {
    const files = {
      ...requiredParts(),
      'word/large.xml': 'x'.repeat(500),
    };
    const bytes = await makeZip(files);
    const strict = {
      ...config,
      docxMaxUncompressedBytes: 10_000,
      docxMaxEntryUncompressedBytes: 100,
    };
    await expectCode(preflightDocx(bytes, strict), 'DOCX_ENTRY_TOO_LARGE');
  });

  it('rejects an abusive compression ratio', async () => {
    // 200 KiB of a single repeated byte compresses to a few hundred bytes,
    // far beyond the default ratio once the 64 KiB floor is exceeded.
    const files = {
      ...requiredParts(),
      'word/padding.xml': 'A'.repeat(200 * 1024),
    };
    const bytes = await makeZip(files);
    await expectCode(preflightDocx(bytes, config), 'DOCX_COMPRESSION_RATIO');
  });

  it('rejects encrypted entries', async () => {
    const bytes = await makeZip(requiredParts());
    const encrypted = Buffer.from(bytes);
    const entry = firstCentralDirectoryEntry(encrypted);
    const flags = encrypted.readUInt16LE(entry + 8);
    encrypted.writeUInt16LE(flags | 0x1, entry + 8);

    await expectCode(preflightDocx(encrypted, config), 'DOCX_ENCRYPTED');
  });

  it('rejects path traversal entry names', async () => {
    const files = {
      ...requiredParts(),
      '../evil.xml': '<evil/>',
    };
    const bytes = await makeZip(files);
    await expectCode(preflightDocx(bytes, config), 'MALFORMED_FILE');
  });

  it('rejects relative traversal in a nested entry name', async () => {
    const files = {
      ...requiredParts(),
      'word/../../evil.xml': '<evil/>',
    };
    const bytes = await makeZip(files);
    await expectCode(preflightDocx(bytes, config), 'MALFORMED_FILE');
  });

  it('rejects absolute entry names', async () => {
    const files = {
      ...requiredParts(),
      '/evil.xml': '<evil/>',
    };
    const bytes = await makeZip(files);
    await expectCode(preflightDocx(bytes, config), 'MALFORMED_FILE');
  });

  it('rejects a missing required DOCX part', async () => {
    const files = {
      '[Content_Types].xml': '<Types/>',
      'word/document.xml': '<w:document/>',
      // _rels/.rels deliberately absent.
    };
    const bytes = await makeZip(files);
    await expectCode(preflightDocx(bytes, config), 'MALFORMED_FILE');
  });

  it('rejects a generic ZIP that is not a DOCX package', async () => {
    const bytes = await makeZip({ 'notes.txt': 'plain text' });
    await expectCode(preflightDocx(bytes, config), 'MALFORMED_FILE');
  });

  it('rejects multi-disk archives', async () => {
    const bytes = await makeZip(requiredParts());
    const patched = Buffer.from(bytes);
    const eocd = findEndOfCentralDirectory(patched);
    patched.writeUInt16LE(1, eocd + 4); // disk number

    await expectCode(preflightDocx(patched, config), 'MALFORMED_FILE');
  });

  it('rejects unsupported compression methods', async () => {
    const bytes = await makeZip(requiredParts());
    const patched = Buffer.from(bytes);
    const entry = firstCentralDirectoryEntry(patched);
    patched.writeUInt16LE(99, entry + 10); // method

    await expectCode(preflightDocx(patched, config), 'MALFORMED_FILE');
  });

  it('never extracts entries to disk', async () => {
    // Structural guarantee: the preflight API is synchronous over bytes and
    // has no filesystem surface. This test documents that contract by
    // confirming a traversal name is rejected without creating anything.
    const files = {
      ...requiredParts(),
      '../should-not-exist.txt': 'payload',
    };
    const bytes = await makeZip(files);
    await expectCode(preflightDocx(bytes, config), 'MALFORMED_FILE');

    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    expect(existsSync(join(process.cwd(), 'should-not-exist.txt'))).toBe(false);
    expect(existsSync(join(process.cwd(), '..', 'should-not-exist.txt'))).toBe(false);
  });

  it('bounds every central-directory entry it reports', async () => {
    const bytes = await makeZip(requiredParts(), 'STORE');
    const inspection = inspectDocxZip(bytes, config);
    for (const entry of inspection.entries) {
      expect(entry.uncompressedSize).toBeLessThanOrEqual(
        config.docxMaxEntryUncompressedBytes,
      );
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.method === 0 || entry.method === 8).toBe(true);
    }
  });
});

describe('M5 Corrective Patch 2 — central directory parsing', () => {
  it('enumerates every entry exactly once', async () => {
    const bytes = await makeZip({
      ...requiredParts(),
      'word/styles.xml': '<styles/>',
      'word/numbering.xml': '<numbering/>',
    });
    const offsets = centralDirectoryEntries(bytes);
    const inspection = inspectDocxZip(bytes, config);
    // Every central-directory record is enumerated exactly once; the count
    // matches the bounded inspector (which also sees JSZip directory records).
    expect(offsets.length).toBe(inspection.entries.length);
    expect(new Set(offsets).size).toBe(offsets.length);
  });
});
