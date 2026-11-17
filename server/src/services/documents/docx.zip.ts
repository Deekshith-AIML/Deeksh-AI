/**
 * services/documents/docx.zip.ts
 * ------------------------------
 * Bounded ZIP inspection for DOCX uploads (Milestone 5).
 *
 * WHY NOT JSZip FOR PREFLIGHT:
 * JSZip must parse and may inflate entries before callers can inspect them.
 * This module reads the ZIP central directory directly from the raw bytes so
 * declared-metadata limits are enforced BEFORE any decompression happens, and
 * then *actually inflates* every DEFLATE entry under a hard output cap so a
 * lying archive cannot expand beyond the configured budget.
 *
 * Enforced guards:
 * - single-disk archives only; ZIP64 rejected (bounded parser)
 * - central directory must be well-formed and within file bounds
 * - entry count cap
 * - per-entry declared uncompressed size cap (cheap first line)
 * - total declared uncompressed size cap (cheap first line)
 * - compression-ratio cap (applied above a small floor to avoid false
 *   positives on tiny highly-compressible XML parts)
 * - ACTUAL per-entry inflate output cap (Node zlib maxOutputLength)
 * - ACTUAL total inflate output cap
 * - wall-clock inspection budget (checked between entries)
 * - encrypted entries rejected
 * - unsupported compression methods rejected
 * - absolute paths, drive letters, backslashes, control characters and
 *   `..` traversal segments rejected
 * - essential OOXML package parts must exist
 *
 * No malware scanning is performed. Nothing here extracts entries to disk.
 */

import type { DocumentsConfig } from '../../config/documents.config.js';
import { inflateRawSync } from 'node:zlib';
import { DocumentValidationError } from './errors.js';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const MAX_COMMENT_SIZE = 65_535;
const RATIO_FLOOR_BYTES = 64 * 1024;
const MAX_ENTRY_NAME_LENGTH = 512;

export const DOCX_REQUIRED_ENTRIES = [
  '[Content_Types].xml',
  '_rels/.rels',
  'word/document.xml',
] as const;

export interface DocxZipEntry {
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export interface DocxZipInspection {
  entries: DocxZipEntry[];
  totalUncompressedBytes: number;
}

function malformed(message = 'This DOCX file is corrupted and cannot be read.'): never {
  throw new DocumentValidationError(message, 'MALFORMED_FILE', 400);
}

function readUInt16(bytes: Buffer, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.length) malformed();
  return bytes.readUInt16LE(offset);
}

function readUInt32(bytes: Buffer, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.length) malformed();
  return bytes.readUInt32LE(offset);
}

/**
 * Reject names that could escape a directory if a downstream consumer ever
 * wrote entries to disk, plus names that are structurally invalid in a ZIP.
 */
function assertSafeEntryName(name: string): void {
  if (!name || name.length > MAX_ENTRY_NAME_LENGTH) malformed();

  // Control characters (including NUL) are never legitimate here.
  if (/[\u0000-\u001f\u007f]/.test(name)) malformed();
  // ZIP paths are forward-slash only.
  if (name.includes('\\')) malformed();
  // Absolute paths / Windows drive letters / UNC-style prefixes.
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) malformed();

  const segments = name.split('/');
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i] ?? '';
    if (segment === '..') malformed();
    // Empty segments are only allowed for a trailing directory marker.
    if (segment === '' && !(i === segments.length - 1 && name.endsWith('/'))) {
      malformed();
    }
  }
}

/** Find the end-of-central-directory record by scanning backwards from EOF. */
function findEndOfCentralDirectory(bytes: Buffer): number {
  if (bytes.length < EOCD_MIN_SIZE) malformed();

  const earliest = Math.max(0, bytes.length - EOCD_MIN_SIZE - MAX_COMMENT_SIZE);
  for (let offset = bytes.length - EOCD_MIN_SIZE; offset >= earliest; offset -= 1) {
    if (bytes.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    const commentLength = bytes.readUInt16LE(offset + 20);
    // The comment must run exactly to the end of the file.
    if (offset + EOCD_MIN_SIZE + commentLength === bytes.length) return offset;
  }

  malformed('This file is not a valid DOCX archive.');
}

/**
 * Inflate a raw DEFLATE stream with a hard output cap.
 *
 * `inflateRawSync(..., { maxOutputLength })` throws `ERR_BUFFER_TOO_LARGE`
 * when the real output exceeds the cap, so a ZIP bomb is bounded by memory,
 * not by attacker-declared metadata. Corrupt streams throw `Z_DATA_ERROR`.
 * Both are translated into stable domain errors; callers never see raw errors.
 */
function inflateBounded(compressed: Buffer, capBytes: number): Buffer {
  try {
    return inflateRawSync(compressed, { maxOutputLength: Math.max(capBytes, 1) });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ERR_BUFFER_TOO_LARGE') {
      throw new DocumentValidationError(
        'This DOCX file expands beyond the allowed size.',
        'DOCX_TOO_LARGE',
        413,
      );
    }
    throw new DocumentValidationError(
      'This DOCX file contains a corrupted internal part.',
      'MALFORMED_FILE',
      400,
    );
  }
}

/**
 * Inspect a DOCX ZIP and enforce every resource/security guard.
 *
 * Throws `DocumentValidationError` with a stable code. Safe to call on
 * completely untrusted bytes; never throws raw RangeError/TypeError.
 */
export function inspectDocxZip(bytes: Buffer, config: DocumentsConfig): DocxZipInspection {
  const startedAt = Date.now();
  const deadline = startedAt + config.docxInspectionTimeoutMs;

  const eocdOffset = findEndOfCentralDirectory(bytes);

  const diskNumber = readUInt16(bytes, eocdOffset + 4);
  const centralDirectoryDisk = readUInt16(bytes, eocdOffset + 6);
  const entriesOnDisk = readUInt16(bytes, eocdOffset + 8);
  const declaredEntryCount = readUInt16(bytes, eocdOffset + 10);
  const centralDirectorySize = readUInt32(bytes, eocdOffset + 12);
  const centralDirectoryOffset = readUInt32(bytes, eocdOffset + 16);

  // Multi-disk archives and ZIP64 are outside the bounded parser.
  if (diskNumber !== 0 || centralDirectoryDisk !== 0) malformed();
  if (entriesOnDisk !== declaredEntryCount) malformed();
  if (declaredEntryCount === 0 || declaredEntryCount === 0xffff) malformed();
  if (centralDirectorySize === 0) malformed();

  if (declaredEntryCount > config.docxMaxEntries) {
    throw new DocumentValidationError(
      'This DOCX file contains too many internal parts.',
      'DOCX_TOO_MANY_ENTRIES',
      400,
    );
  }

  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
  if (
    centralDirectoryOffset >= eocdOffset ||
    centralDirectoryEnd > eocdOffset ||
    centralDirectoryEnd > bytes.length
  ) {
    malformed();
  }

  const entries: DocxZipEntry[] = [];
  let declaredTotal = 0;
  let actualTotal = 0;
  let cursor = centralDirectoryOffset;

  for (let index = 0; index < declaredEntryCount; index += 1) {
    if (Date.now() > deadline) {
      throw new DocumentValidationError(
        'This DOCX file took too long to inspect.',
        'DOCX_INSPECTION_TIMEOUT',
        408,
      );
    }

    if (cursor + 46 > centralDirectoryEnd) malformed();
    if (readUInt32(bytes, cursor) !== CENTRAL_DIRECTORY_SIGNATURE) malformed();

    const flags = readUInt16(bytes, cursor + 8);
    const method = readUInt16(bytes, cursor + 10);
    const compressedSize = readUInt32(bytes, cursor + 20);
    const uncompressedSize = readUInt32(bytes, cursor + 24);
    const nameLength = readUInt16(bytes, cursor + 28);
    const extraLength = readUInt16(bytes, cursor + 30);
    const commentLength = readUInt16(bytes, cursor + 32);
    const localHeaderOffset = readUInt32(bytes, cursor + 42);
    const recordLength = 46 + nameLength + extraLength + commentLength;

    if (nameLength === 0 || cursor + recordLength > centralDirectoryEnd) malformed();

    // ZIP64 markers are not supported by this bounded parser.
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      malformed('This DOCX file uses an unsupported ZIP64 structure.');
    }

    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    assertSafeEntryName(name);

    if ((flags & 0x1) !== 0) {
      throw new DocumentValidationError(
        'Password-protected documents are not supported.',
        'DOCX_ENCRYPTED',
        400,
      );
    }

    if (method !== 0 && method !== 8) {
      malformed('This DOCX file uses an unsupported compression method.');
    }

    // The local header must exist where the central directory says it does.
    if (
      localHeaderOffset + 30 > bytes.length ||
      readUInt32(bytes, localHeaderOffset) !== LOCAL_FILE_SIGNATURE
    ) {
      malformed();
    }

    // Per-entry declared size cap (attacker-controlled metadata first line).
    if (uncompressedSize > config.docxMaxEntryUncompressedBytes) {
      throw new DocumentValidationError(
        'This DOCX file contains an internal part that is too large.',
        'DOCX_ENTRY_TOO_LARGE',
        413,
      );
    }

    declaredTotal += uncompressedSize;
    if (declaredTotal > config.docxMaxUncompressedBytes) {
      throw new DocumentValidationError(
        'This DOCX file expands beyond the allowed size.',
        'DOCX_TOO_LARGE',
        413,
      );
    }

    // Compression-ratio cap (applied above a small floor to avoid false
    // positives on tiny highly-compressible XML parts).
    if (uncompressedSize > RATIO_FLOOR_BYTES) {
      const unsafeRatio =
        compressedSize === 0 ||
        uncompressedSize / compressedSize > config.docxMaxCompressionRatio;
      if (unsafeRatio) {
        throw new DocumentValidationError(
          'This DOCX file has an unsafe compression ratio.',
          'DOCX_COMPRESSION_RATIO',
          400,
        );
      }
    }

    // ---- ACTUAL DECOMPRESSION BOUNDS ----
    // The local header carries its own name/extra lengths; compressed data
    // does NOT necessarily start at localHeaderOffset + 30.
    const localNameLength = readUInt16(bytes, localHeaderOffset + 26);
    const localExtraLength = readUInt16(bytes, localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.length) malformed();

    const compressedPayload = bytes.subarray(dataStart, dataEnd);
    const remainingBudget = config.docxMaxUncompressedBytes - actualTotal;
    if (remainingBudget <= 0) {
      throw new DocumentValidationError(
        'This DOCX file expands beyond the allowed size.',
        'DOCX_TOO_LARGE',
        413,
      );
    }
    const perEntryCap = Math.min(config.docxMaxEntryUncompressedBytes, remainingBudget);

    let actualSize: number;
    if (compressedSize === 0) {
      // Directory records / empty files: nothing to inflate.
      actualSize = 0;
    } else if (method === 8) {
      const inflated = inflateBounded(compressedPayload, perEntryCap);
      actualSize = inflated.length;
    } else {
      // STORE: the payload is the output; the declared size must be honest.
      if (compressedSize > perEntryCap || uncompressedSize > perEntryCap) {
        throw new DocumentValidationError(
          'This DOCX file contains an internal part that is too large.',
          'DOCX_ENTRY_TOO_LARGE',
          413,
        );
      }
      actualSize = compressedSize;
    }

    actualTotal += actualSize;
    if (actualTotal > config.docxMaxUncompressedBytes) {
      throw new DocumentValidationError(
        'This DOCX file expands beyond the allowed size.',
        'DOCX_TOO_LARGE',
        413,
      );
    }

    entries.push({
      name,
      flags,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });

    cursor += recordLength;
  }

  // The central directory must be consumed exactly (no hidden records).
  if (cursor !== centralDirectoryEnd) malformed();

  const names = new Set(entries.map((entry) => entry.name));
  for (const required of DOCX_REQUIRED_ENTRIES) {
    if (!names.has(required)) {
      throw new DocumentValidationError(
        'This archive is not a Word document.',
        'MALFORMED_FILE',
        400,
      );
    }
  }

  return { entries, totalUncompressedBytes: actualTotal };
}
