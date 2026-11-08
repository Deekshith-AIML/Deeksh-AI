/**
 * middleware/upload.middleware.ts
 * -------------------------------
 * Multipart upload handling for Knowledge Base documents.
 *
 * - Memory storage only: nothing is written to disk by Express.
 * - One file per request, field name `file`.
 * - The size limit is enforced by multer while streaming (so an oversized
 *   upload is cut off rather than buffered completely) and re-checked by the
 *   service from the actual byte length.
 * - Multer errors are translated into safe client responses; raw parser
 *   errors never reach the client.
 */

import multer from 'multer';
import type { Request, Response, NextFunction } from 'express';
import { getDocumentsConfig } from '../config/documents.config.js';

const MAX_FIELD_SIZE_BYTES = 1024; // filename etc.

export function documentUploadMiddleware() {
  const { maxUploadBytes } = getDocumentsConfig();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: maxUploadBytes,
      files: 1,
      fields: 4,
      fieldSize: MAX_FIELD_SIZE_BYTES,
    },
  });

  return function handleUpload(req: Request, res: Response, next: NextFunction): void {
    upload.single('file')(req, res, (err: unknown) => {
      if (!err) {
        next();
        return;
      }
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({
            error: `File exceeds the ${Math.floor(maxUploadBytes / (1024 * 1024))} MB limit.`,
            code: 'FILE_TOO_LARGE',
          });
          return;
        }
        res.status(400).json({
          error: 'Upload rejected.',
          code: err.code,
        });
        return;
      }
      next(err);
    });
  };
}
