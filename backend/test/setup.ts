/**
 * Test bootstrap, loaded with `--import` before any test file.
 * config/env.ts validates at import time, so the variables it requires are set
 * here, and uploads are pointed at a throwaway directory so no test touches the
 * real ./uploads folder. Values already present (e.g. from CI) are overridden
 * on purpose: tests must never write to a real upload volume or database.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'help-backend-test-'));

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-only-secret-not-used-anywhere-0123456789abcdef';
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/unused';
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.TEST_TMP_DIR = tmp;

process.on('exit', () => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
