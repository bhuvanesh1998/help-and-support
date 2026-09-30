import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { Request } from 'express';
import {
  CHUNK_BYTES,
  appendChunk,
  cancelUpload,
  createUpload,
  getUpload,
  sweepUploads,
  takeCompletedUpload,
} from './chunked-upload.service.js';
import { uploadDir } from '../../lib/upload.js';

const USER = 'user-a';
const OTHER = 'user-b';
const MAX_MB = 10_000;

/** A request stand-in: appendChunk only pipes the body and listens for events. */
function body(bytes: number | Buffer): Request {
  const buf = typeof bytes === 'number' ? Buffer.alloc(bytes, 7) : bytes;
  return Readable.from([buf]) as unknown as Request;
}

function partPath(id: string): string {
  return path.join(uploadDir, `${id}.part`);
}

test('uploadDir is the isolated test directory', () => {
  assert.ok(process.env.TEST_TMP_DIR && uploadDir.startsWith(process.env.TEST_TMP_DIR));
});

test('createUpload rejects non-video extensions', () => {
  for (const name of ['clip.exe', 'clip.mp4.html', 'noext', 'image.png']) {
    assert.throws(() => createUpload(USER, name, 100, MAX_MB), /Only MP4/);
  }
});

test('createUpload rejects invalid or oversized sizes', () => {
  assert.throws(() => createUpload(USER, 'a.mp4', 0, MAX_MB), /valid file size/);
  assert.throws(() => createUpload(USER, 'a.mp4', -5, MAX_MB), /valid file size/);
  assert.throws(() => createUpload(USER, 'a.mp4', 1.5, MAX_MB), /valid file size/);
  assert.throws(() => createUpload(USER, 'a.mp4', 2 * 1024 * 1024 + 1, 2), /2 MB limit/);
});

test('createUpload opens an empty part file named by the server, not the client', () => {
  const s = createUpload(USER, '../../etc/evil.MOV', 10, MAX_MB);
  assert.equal(s.receivedBytes, 0);
  assert.equal(s.sizeBytes, 10);
  assert.equal(s.chunkBytes, CHUNK_BYTES);
  assert.equal(s.complete, false);
  assert.equal(fs.statSync(partPath(s.uploadId)).size, 0);
  cancelUpload(s.uploadId, USER);
});

test('sessions are private to their owner', async () => {
  const s = createUpload(USER, 'a.mp4', 10, MAX_MB);
  assert.throws(() => getUpload(s.uploadId, OTHER), /not found/);
  await assert.rejects(appendChunk(s.uploadId, OTHER, 0, body(10)), /not found/);
  assert.throws(() => takeCompletedUpload(s.uploadId, OTHER), /not found/);

  cancelUpload(s.uploadId, OTHER); // a stranger's cancel is a no-op
  assert.equal(getUpload(s.uploadId, USER).uploadId, s.uploadId);
  assert.ok(fs.existsSync(partPath(s.uploadId)));

  cancelUpload(s.uploadId, USER);
  assert.throws(() => getUpload(s.uploadId, USER), /not found/);
  assert.equal(fs.existsSync(partPath(s.uploadId)), false);
});

test('an offset mismatch is rejected with resumeAt set to the stored byte count', async () => {
  const s = createUpload(USER, 'a.mp4', 10, MAX_MB);
  await assert.rejects(appendChunk(s.uploadId, USER, 5, body(5)), (err: Error & { resumeAt?: number }) => {
    assert.match(err.message, /Expected offset 0/);
    assert.equal(err.resumeAt, 0);
    return true;
  });
  cancelUpload(s.uploadId, USER);
});

test('a short (non-final) piece is rolled back off the file', async () => {
  const size = CHUNK_BYTES + 10;
  const s = createUpload(USER, 'big.webm', size, MAX_MB);
  await assert.rejects(appendChunk(s.uploadId, USER, 0, body(1000)), /expected 33554432/);
  assert.equal(getUpload(s.uploadId, USER).receivedBytes, 0);
  assert.equal(fs.statSync(partPath(s.uploadId)).size, 0);
  cancelUpload(s.uploadId, USER);
});

test('an oversized piece is rejected and nothing is kept', async () => {
  const s = createUpload(USER, 'a.mp4', 10, MAX_MB);
  await assert.rejects(appendChunk(s.uploadId, USER, 0, body(11)), /larger than expected/);
  assert.equal(getUpload(s.uploadId, USER).receivedBytes, 0);
  assert.equal(fs.statSync(partPath(s.uploadId)).size, 0);
  cancelUpload(s.uploadId, USER);
});

test('a retried piece that already landed reports where to resume', async () => {
  const s = createUpload(USER, 'a.mp4', 10, MAX_MB);
  await appendChunk(s.uploadId, USER, 0, body(10));
  await assert.rejects(appendChunk(s.uploadId, USER, 0, body(10)), (err: Error & { resumeAt?: number }) => {
    assert.equal(err.resumeAt, 10);
    return true;
  });
  cancelUpload(s.uploadId, USER);
});

test('completion: a full piece then a short final piece, then hand-off', async () => {
  const size = CHUNK_BYTES + 3;
  const s = createUpload(USER, 'Walkthrough.MP4', size, MAX_MB);

  assert.throws(() => takeCompletedUpload(s.uploadId, USER), /not finished/);

  const first = await appendChunk(s.uploadId, USER, 0, body(CHUNK_BYTES));
  assert.equal(first.receivedBytes, CHUNK_BYTES);
  assert.equal(first.complete, false);

  const last = await appendChunk(s.uploadId, USER, CHUNK_BYTES, body(Buffer.from([1, 2, 3])));
  assert.equal(last.receivedBytes, size);
  assert.equal(last.complete, true);

  const done = takeCompletedUpload(s.uploadId, USER);
  assert.equal(done.originalName, 'Walkthrough.MP4');
  assert.equal(done.path, path.join(uploadDir, `${s.uploadId}.mp4`));
  assert.equal(fs.statSync(done.path).size, size);
  assert.equal(fs.existsSync(partPath(s.uploadId)), false);

  // The session is gone once the job owns the file.
  assert.throws(() => getUpload(s.uploadId, USER), /not found/);
  fs.unlinkSync(done.path);
});

test('sweepUploads removes orphaned part files but keeps live sessions', () => {
  const live = createUpload(USER, 'a.mp4', 10, MAX_MB);
  const orphan = path.join(uploadDir, 'left-over-from-restart.part');
  const unrelated = path.join(uploadDir, 'image.png');
  fs.writeFileSync(orphan, 'x');
  fs.writeFileSync(unrelated, 'x');

  sweepUploads();

  assert.equal(fs.existsSync(orphan), false);
  assert.equal(fs.existsSync(unrelated), true);
  assert.equal(fs.existsSync(partPath(live.uploadId)), true);
  cancelUpload(live.uploadId, USER);
  fs.unlinkSync(unrelated);
});
