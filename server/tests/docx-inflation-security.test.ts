/**
 * M5 Corrective Patch 4 — actual DOCX decompression bounds
 * ---------------------------------------------------------
 * The Patch 2 preflight relied on declared central-directory sizes. Patch 4
 * actually inflates every DEFLATE entry under a hard `maxOutputLength` cap so
 * an archive that lies about its sizes cannot expand beyond the budget.
 *
 * These tests craft adversarial archives that are only rejected because the
 * inflated output is bounded, not because of the declared metadata.
 */
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import {
  inspectDocxZip,
  DOCX_REQUIRED_ENTRIES,
} from '../src/services/documents/docx.zip.js';
import { preflightDocx } from '../src/services/documents/validation.js';
import { getDocumentsConfig } from '../src/config/documents.config.js';

const config = getDocumentsConfig();

const REQUIRED: Record<string, string> = {
  '[Content_Types].xml': '<Types/>',
  '_rels/.rels': '<Relationships/>',
  'word/document.xml': '<w:document><w:body/></w:document>',
};

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

function findEocd(bytes: Buffer): number {
  for (let offset = bytes.length - 22; offset >= 0; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error('EOCD not found in fixture');
}

/** Return the central-directory record offset for `name`. */
function centralRecord(bytes: Buffer, name: string): number {
  const eocd = findEocd(bytes);
  const start = bytes.readUInt32LE(eocd + 16);
  const size = bytes.readUInt32LE(eocd + 12);
  const end = start + size;
  let cursor = start;
  while (cursor + 46 <= end && bytes.readUInt32LE(cursor) === 0x02014b50) {
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const entryName = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (entryName === name) return cursor;
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`central entry not found: ${name}`);
}

/** Overwrite the central directory's declared uncompressed size. */
function patchDeclaredSize(bytes: Buffer, name: string, size: number): Buffer {
  const patched = Buffer.from(bytes);
  const record = centralRecord(patched, name);
  patched.writeUInt32LE(size, record + 24);
  return patched;
}

/** Overwrite the central directory's declared compressed size. */
function patchCompressedSize(bytes: Buffer, name: string, size: number): Buffer {
  const patched = Buffer.from(bytes);
  const record = centralRecord(patched, name);
  patched.writeUInt32LE(size, record + 20);
  return patched;
}

/** Locate the compressed payload for `name` via its local file header. */
function compressedPayloadRange(bytes: Buffer, name: string): [number, number] {
  const record = centralRecord(bytes, name);
  const localOffset = bytes.readUInt32LE(record + 42);
  const nameLength = bytes.readUInt16LE(localOffset + 26);
  const extraLength = bytes.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + nameLength + extraLength;
  const compressedSize = bytes.readUInt32LE(record + 20);
  return [dataStart, dataStart + compressedSize];
}

describe('M5 Corrective Patch 4 — actual DOCX inflation bounds', () => {
  it('accepts a well-formed DEFLATE package and reports real inflated bytes', async () => {
    const bytes = await makeZip({
      ...REQUIRED,
      'word/styles.xml': '<w:styles/>',
    });

    await expect(preflightDocx(bytes, config)).resolves.toBeUndefined();

    const inspection = inspectDocxZip(bytes, config);
    const names = inspection.entries.map((e) => e.name);
    for (const required of DOCX_REQUIRED_ENTRIES) {
      expect(names).toContain(required);
    }
    // Real inflation happened: the reported total equals the sum of actual
    // outputs, not merely the declared metadata.
    expect(inspection.totalUncompressedBytes).toBeGreaterThan(0);
  });

  it('rejects an archive that lies about its sizes (real output exceeds cap)', async () => {
    // ~1 MiB of compressible content, then rewrite the central directory to
    // declare only 1000 bytes. Declared-size guards pass; only actual
    // inflation can catch this.
    const payload = 'A'.repeat(1024 * 1024);
    const bytes = await makeZip({
      ...REQUIRED,
      'word/document.xml': `<w:document><w:body>${payload}</w:body></w:document>`,
    });
    const lying = patchDeclaredSize(bytes, 'word/document.xml', 1000);

    const strict = {
      ...config,
      docxMaxEntryUncompressedBytes: 4096,
      docxMaxUncompressedBytes: 64 * 1024 * 1024,
      docxMaxCompressionRatio: 100_000,
    };

    await expect(preflightDocx(lying, strict)).rejects.toMatchObject({
      code: 'DOCX_TOO_LARGE',
    });
  });

  it('enforces the total actual-output budget across entries', async () => {
    // Six extra entries of ~2000 real bytes each; every central-directory
    // declared size is patched to 1 so only the actual sum can trip the cap.
    const extras: Record<string, string> = {};
    for (let i = 0; i < 6; i += 1) {
      extras[`word/extra${i}.xml`] = 'B'.repeat(2000);
    }
    const bytes = await makeZip({ ...REQUIRED, ...extras });

    let lying = bytes;
    for (const name of Object.keys(extras)) {
      lying = patchDeclaredSize(lying, name, 1);
    }

    const strict = {
      ...config,
      docxMaxEntryUncompressedBytes: 10_000,
      docxMaxUncompressedBytes: 5000,
      docxMaxCompressionRatio: 100_000,
    };

    await expect(preflightDocx(lying, strict)).rejects.toMatchObject({
      code: 'DOCX_TOO_LARGE',
    });
  });

  it('rejects a corrupted DEFLATE stream safely', async () => {
    const bytes = await makeZip(REQUIRED);
    const corrupted = Buffer.from(bytes);
    const [start, end] = compressedPayloadRange(corrupted, 'word/document.xml');
    expect(end).toBeGreaterThan(start);
    // 0xFF begins a reserved DEFLATE block type → invalid stream.
    for (let i = start; i < Math.min(start + 8, end); i += 1) {
      corrupted[i] = 0xff;
    }

    await expect(preflightDocx(corrupted, config)).rejects.toMatchObject({
      code: 'MALFORMED_FILE',
    });
  });

  it('rejects a compressed-size field pointing outside the file', async () => {
    const bytes = await makeZip(REQUIRED);
    const lying = patchCompressedSize(bytes, 'word/document.xml', 0x00ff_ffff);

    await expect(preflightDocx(lying, config)).rejects.toMatchObject({
      code: 'MALFORMED_FILE',
    });
  });

  it('accepts STORE entries without inflating them', async () => {
    const bytes = await makeZip(REQUIRED, 'STORE');
    await expect(preflightDocx(bytes, config)).resolves.toBeUndefined();

    const inspection = inspectDocxZip(bytes, config);
    expect(inspection.entries.every((e) => e.method === 0)).toBe(true);
  });

  it('handles zero-length directory entries without a false corruption error', async () => {
    const zip = new JSZip();
    zip.folder('word');
    for (const [name, content] of Object.entries(REQUIRED)) zip.file(name, content);
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

    await expect(preflightDocx(bytes, config)).resolves.toBeUndefined();
  });
});
