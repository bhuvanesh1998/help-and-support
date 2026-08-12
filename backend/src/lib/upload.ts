import multer from 'multer';
import type { Multer } from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

const uploadDir = path.resolve(env.uploadDir);
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${randomUUID()}${ext}`);
  },
});

export const upload = multer({
  storage,
  limits: { fileSize: env.maxUploadMb * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type "${file.mimetype}" not allowed. Accepted: JPEG, PNG, GIF, WebP.`));
    }
  },
});

// Separate uploader for backup restore: a single .zip held in memory (parsed,
// not stored). Larger limit since it carries the full image set.
export const backupUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 512 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const okMime = [
      'application/zip',
      'application/x-zip-compressed',
      'application/octet-stream',
      'multipart/x-zip',
    ].includes(file.mimetype);
    if (okMime || file.originalname.toLowerCase().endsWith('.zip')) {
      cb(null, true);
    } else {
      cb(new Error('Backup must be a .zip file'));
    }
  },
});

// Separate uploader for Voiceover Studio source videos: written to disk (they
// are far too large to hold in memory), and removed as soon as frames have been
// extracted from them.
const ALLOWED_VIDEO_MIME = new Set([
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
  'video/x-msvideo',
  'video/mpeg',
]);

/**
 * Built per request rather than once at module load, because the size limit is
 * an admin-editable setting — a fixed instance would pin the limit to whatever
 * it was when the process started.
 */
export function videoUpload(maxMb: number): Multer {
  return multer({
    storage,
    limits: { fileSize: maxMb * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const okExt = /\.(mp4|mov|webm|mkv|avi|mpe?g)$/i.test(file.originalname);
      if (ALLOWED_VIDEO_MIME.has(file.mimetype) || okExt) {
        cb(null, true);
      } else {
        cb(
          new Error(
            `File type "${file.mimetype}" not allowed. Accepted: MP4, MOV, WebM, MKV, AVI.`,
          ),
        );
      }
    },
  });
}

export { uploadDir };
