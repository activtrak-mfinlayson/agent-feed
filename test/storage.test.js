import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from '../src/storage/database.js';

describe('Database', () => {
  let tmpDir;
  let db;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-feed-db-test-'));
    db = new Database(path.join(tmpDir, 'test.db'));
    await db.init();
  });

  after(async () => {
    await db.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  describe('insertRecord', () => {
    it('inserts a record and returns an id', async () => {
      const id = await db.insertRecord({
        timestamp: new Date().toISOString(),
        agent: 'claude-code',
        agent_version: null,
        session_id: 'sess-001',
        turn_index: 1,
        repo: 'my-repo',
        working_directory: '/home/user/project',
        git_branch: 'main',
        git_commit: 'abc123',
        request_summary: 'write a function',
        response_summary: 'wrote a function',
        raw_request: '{"prompt":"write a function"}',
        raw_response: '{"content":"here is a function"}',
        token_count: 120,
        model: 'claude-sonnet-4-6',
      });
      assert.ok(id);
      assert.equal(typeof id, 'string');
    });

    it('inserts a record without optional fields', async () => {
      const id = await db.insertRecord({
        timestamp: new Date().toISOString(),
        agent: 'claude-code',
        session_id: 'sess-002',
        turn_index: 1,
        working_directory: '/home/user/project',
        response_summary: 'did something',
        raw_response: '{"content":"something"}',
        model: 'claude-sonnet-4-6',
      });
      assert.ok(id);
    });
  });

  describe('insertFlag', () => {
    it('inserts a flag linked to a record', async () => {
      const recordId = await db.insertRecord({
        timestamp: new Date().toISOString(),
        agent: 'claude-code',
        session_id: 'sess-003',
        turn_index: 1,
        working_directory: '/tmp',
        response_summary: 'made a decision',
        raw_response: '{"content":"I decided to use JWT"}',
        model: 'claude-sonnet-4-6',
      });

      const flagId = await db.insertFlag({
        record_id: recordId,
        type: 'decision',
        content: 'Chose JWT over session cookies',
        confidence: 0.92,
      });
      assert.ok(flagId);
    });

    it('rejects unknown flag types', async () => {
      await assert.rejects(async () => {
        await db.insertFlag({
          record_id: 'fake-id',
          type: 'unknown_type',
          content: 'something',
          confidence: 0.9,
        });
      });
    });
  });

  describe('getSession', () => {
    it('returns all records for a session in turn order', async () => {
      const sessionId = 'sess-order-test';
      await db.insertRecord({
        timestamp: new Date().toISOString(),
        agent: 'claude-code',
        session_id: sessionId,
        turn_index: 2,
        working_directory: '/tmp',
        response_summary: 'second turn',
        raw_response: '{}',
        model: 'claude-sonnet-4-6',
      });
      await db.insertRecord({
        timestamp: new Date().toISOString(),
        agent: 'claude-code',
        session_id: sessionId,
        turn_index: 1,
        working_directory: '/tmp',
        response_summary: 'first turn',
        raw_response: '{}',
        model: 'claude-sonnet-4-6',
      });

      const records = await db.getSession(sessionId);
      assert.equal(records.length, 2);
      assert.equal(records[0].turn_index, 1);
      assert.equal(records[1].turn_index, 2);
    });
  });

  describe('listSessions', () => {
    it('returns unique sessions sorted by most recent first', async () => {
      const sessions = await db.listSessions();
      assert.ok(Array.isArray(sessions));
      assert.ok(sessions.length > 0);
      // each entry has session_id and latest_timestamp
      assert.ok(sessions[0].session_id);
      assert.ok(sessions[0].latest_timestamp);
    });
  });

  describe('updateFlagReview', () => {
    it('updates review status and note on a flag', async () => {
      const recordId = await db.insertRecord({
        timestamp: new Date().toISOString(),
        agent: 'claude-code',
        session_id: 'sess-review',
        turn_index: 1,
        working_directory: '/tmp',
        response_summary: 'a response',
        raw_response: '{}',
        model: 'claude-sonnet-4-6',
      });
      const flagId = await db.insertFlag({
        record_id: recordId,
        type: 'assumption',
        content: 'Assumed postgres is available',
        confidence: 0.85,
      });

      await db.updateFlagReview(flagId, {
        review_status: 'accepted',
        reviewer_note: 'correct assumption',
        outcome: 'no change needed',
      });

      const flags = await db.getFlagsForRecord(recordId);
      const flag = flags.find(f => f.id === flagId);
      assert.equal(flag.review_status, 'accepted');
      assert.equal(flag.reviewer_note, 'correct assumption');
      assert.equal(flag.outcome, 'no change needed');
    });
  });

  describe('getFlagCountForSession', () => {
    it('counts all flags for a session across multiple records and review statuses', async () => {
      const sessionId = 'sess-flag-count-test';
      const record1 = await db.insertRecord({
        timestamp: new Date().toISOString(),
        agent: 'claude-code',
        session_id: sessionId,
        turn_index: 1,
        working_directory: '/tmp',
        response_summary: 'first turn',
        raw_response: '{}',
        model: 'claude-sonnet-4-6',
      });
      const record2 = await db.insertRecord({
        timestamp: new Date().toISOString(),
        agent: 'claude-code',
        session_id: sessionId,
        turn_index: 2,
        working_directory: '/tmp',
        response_summary: 'second turn',
        raw_response: '{}',
        model: 'claude-sonnet-4-6',
      });

      const flagId1 = await db.insertFlag({
        record_id: record1,
        type: 'decision',
        content: 'decision one',
        confidence: 0.9,
      });
      await db.insertFlag({
        record_id: record1,
        type: 'risk',
        content: 'risk one',
        confidence: 0.8,
      });
      await db.insertFlag({
        record_id: record2,
        type: 'assumption',
        content: 'assumption one',
        confidence: 0.7,
      });
      await db.updateFlagReview(flagId1, { review_status: 'false_positive' });

      const count = await db.getFlagCountForSession(sessionId);
      assert.equal(count, 3, 'should count all flags regardless of review_status');
    });

    it('returns 0 (not an error) for a session with no flags', async () => {
      const sessionId = 'sess-no-flags-test';
      await db.insertRecord({
        timestamp: new Date().toISOString(),
        agent: 'claude-code',
        session_id: sessionId,
        turn_index: 1,
        working_directory: '/tmp',
        response_summary: 'a turn with no flags',
        raw_response: '{}',
        model: 'claude-sonnet-4-6',
      });

      const count = await db.getFlagCountForSession(sessionId);
      assert.equal(count, 0);
    });

    it('returns 0 for a session_id that does not exist at all', async () => {
      const count = await db.getFlagCountForSession('sess-does-not-exist');
      assert.equal(count, 0);
    });
  });

  describe('session digests', () => {
    it('getSessionDigest returns null for a session with no saved digest', async () => {
      const digest = await db.getSessionDigest('sess-digest-none');
      assert.equal(digest, null);
    });

    it('round-trips content through saveSessionDigest/getSessionDigest', async () => {
      const sessionId = 'sess-digest-roundtrip';
      const content = {
        highlights: [
          { summary: 'Chose JWT over sessions', flag_ids: ['flag-a', 'flag-b'] },
          { summary: 'Assumed postgres is available', flag_ids: ['flag-c'] },
        ],
      };

      await db.saveSessionDigest(sessionId, {
        generated_at: '2026-07-29T00:00:00.000Z',
        flag_count_at_generation: 12,
        content,
        model: 'claude-sonnet-4-6',
      });

      const digest = await db.getSessionDigest(sessionId);
      assert.ok(digest);
      assert.equal(digest.session_id, sessionId);
      assert.equal(digest.generated_at, '2026-07-29T00:00:00.000Z');
      assert.equal(digest.flag_count_at_generation, 12);
      assert.equal(digest.model, 'claude-sonnet-4-6');
      assert.deepEqual(digest.content, content);
    });

    it('saving a digest twice for the same session upserts rather than duplicating', async () => {
      const sessionId = 'sess-digest-upsert';

      await db.saveSessionDigest(sessionId, {
        generated_at: '2026-07-29T00:00:00.000Z',
        flag_count_at_generation: 5,
        content: { highlights: [{ summary: 'first pass', flag_ids: ['x'] }] },
        model: 'claude-sonnet-4-6',
      });
      await db.saveSessionDigest(sessionId, {
        generated_at: '2026-07-29T01:00:00.000Z',
        flag_count_at_generation: 9,
        content: { highlights: [{ summary: 'second pass', flag_ids: ['y', 'z'] }] },
        model: 'claude-sonnet-4-7',
      });

      const digest = await db.getSessionDigest(sessionId);
      assert.equal(digest.generated_at, '2026-07-29T01:00:00.000Z');
      assert.equal(digest.flag_count_at_generation, 9);
      assert.equal(digest.model, 'claude-sonnet-4-7');
      assert.deepEqual(digest.content, { highlights: [{ summary: 'second pass', flag_ids: ['y', 'z'] }] });

      const rows = db.db.prepare('SELECT COUNT(*) as count FROM session_digests WHERE session_id = ?').get(sessionId);
      assert.equal(rows.count, 1, 'upsert must not create a duplicate row');
    });
  });

  describe('getDbSizeBytes', () => {
    it('includes WAL and SHM sidecar files in size calculation', async () => {
      // Get size of main .db file alone
      const mainDbSize = fs.statSync(db.dbPath).size;

      // Write enough data to ensure non-trivial WAL file is created
      for (let i = 0; i < 10; i++) {
        await db.insertRecord({
          timestamp: new Date().toISOString(),
          agent: 'claude-code',
          session_id: `sess-wal-test-${i}`,
          turn_index: 1,
          working_directory: '/tmp',
          response_summary: `test record ${i}`,
          raw_response: `{"data":"` + 'x'.repeat(1000) + `"}`,
          model: 'claude-sonnet-4-6',
        });
      }

      // Get total size including WAL/SHM files
      const totalSize = await db.getDbSizeBytes();

      // Sum the sidecar files directly so this test actually verifies they
      // are included, rather than relying on totalSize >= mainDbSize (which
      // would also pass with the old single-file implementation if the main
      // db file happened to grow between measurements, e.g. via checkpoint).
      const statSize = (p) => {
        try { return fs.statSync(p).size; } catch { return 0; }
      };
      const expectedSize = statSize(db.dbPath) + statSize(`${db.dbPath}-wal`) + statSize(`${db.dbPath}-shm`);

      assert.equal(totalSize, expectedSize,
        `getDbSizeBytes() (${totalSize}) should equal the sum of db+wal+shm (${expectedSize})`);
      assert.ok(totalSize >= mainDbSize,
        `Total size (${totalSize}) should include main db file (${mainDbSize})`);
      assert.ok(totalSize > 0, 'Total size should be greater than 0');
    });
  });
});
