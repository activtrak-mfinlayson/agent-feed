// Test for log file rotation when size cap is exceeded.
// Verifies that when a log file would exceed the size threshold,
// it is rotated (old content moved to .1) and a new log is started.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rotateLogIfNeeded, MAX_LOG_SIZE } from '../src/cli/index.js';

describe('Log file rotation', () => {
  it('rotates log file when size exceeds cap', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-feed-log-rotation-'));
    const logPath = path.join(tmpDir, 'test.log');
    const rotatedPath = `${logPath}.1`;

    try {
      // Create initial log content (500 bytes)
      const initialContent = 'x'.repeat(500) + '\n';
      fs.writeFileSync(logPath, initialContent);
      const initialStats = fs.statSync(logPath);
      assert.equal(initialStats.size, 501);

      // Rotate with a small cap (smaller than initial content)
      rotateLogIfNeeded(logPath, 300);

      // Original content should be copied to .1, and the original log
      // truncated in place (not renamed away) so an inherited fd pointing
      // at it keeps working.
      assert.ok(fs.existsSync(rotatedPath), 'rotated file should exist at .1');
      assert.ok(fs.existsSync(logPath), 'original log file should still exist');
      assert.equal(fs.statSync(logPath).size, 0, 'original log file should be truncated to 0 bytes');

      // Verify rotated file has original content
      const rotatedContent = fs.readFileSync(rotatedPath, 'utf8');
      assert.equal(rotatedContent, initialContent);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not rotate when log file is below cap', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-feed-log-no-rotate-'));
    const logPath = path.join(tmpDir, 'test.log');
    const rotatedPath = `${logPath}.1`;

    try {
      // Create log content (100 bytes, well below cap)
      const content = 'y'.repeat(100) + '\n';
      fs.writeFileSync(logPath, content);

      // Try to rotate with a high cap (higher than content)
      rotateLogIfNeeded(logPath, 10000);

      // Original log should still exist, no .1 file created
      assert.ok(fs.existsSync(logPath), 'original log file should still exist');
      assert.ok(!fs.existsSync(rotatedPath), 'no rotated file should be created');

      // Verify original content unchanged
      const readContent = fs.readFileSync(logPath, 'utf8');
      assert.equal(readContent, content);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('handles non-existent log file gracefully', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-feed-log-missing-'));
    const logPath = path.join(tmpDir, 'nonexistent.log');

    try {
      // Should not throw when log file doesn't exist
      rotateLogIfNeeded(logPath, 1024);
      assert.ok(true, 'should complete without error');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('overwrites existing .1 file on rotation', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-feed-log-overwrite-'));
    const logPath = path.join(tmpDir, 'test.log');
    const rotatedPath = `${logPath}.1`;

    try {
      // Create an old rotated file with different content
      fs.writeFileSync(rotatedPath, 'old rotated content\n');

      // Create new log content
      const newContent = 'z'.repeat(500) + '\n';
      fs.writeFileSync(logPath, newContent);

      // Rotate with small cap
      rotateLogIfNeeded(logPath, 300);

      // Verify .1 file now has the new content
      const rotatedContent = fs.readFileSync(rotatedPath, 'utf8');
      assert.equal(rotatedContent, newContent);
      assert.equal(fs.statSync(logPath).size, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('proves rotation triggers under load with real append scenario', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-feed-load-test-'));
    const logPath = path.join(tmpDir, 'test.log');
    const rotatedPath = `${logPath}.1`;

    // Use a small cap for testing (1 KB)
    const testCap = 1024;

    try {
      // Simulate repeated log writes (like in real agent-feed usage)
      // Each line is ~90 bytes when formatted with timestamp
      const logMessage = 'x'.repeat(70); // Will be ~90 bytes with timestamp/newline

      let rotationHappened = false;

      // Write until we cross the cap threshold
      for (let i = 0; i < 50; i++) {
        rotateLogIfNeeded(logPath, testCap);

        const timestamp = new Date().toISOString();
        const line = `[${timestamp}] ${logMessage}\n`;
        fs.appendFileSync(logPath, line);

        // After rotation, original should be at .1 and logPath should exist
        if (fs.existsSync(rotatedPath) && fs.existsSync(logPath)) {
          rotationHappened = true;
          break;
        }
      }

      assert.ok(rotationHappened, 'rotation should have occurred during load test');

      // Verify both files exist and .1 is the older content
      assert.ok(fs.existsSync(logPath), 'current log file should exist');
      assert.ok(fs.existsSync(rotatedPath), 'rotated log file (.1) should exist');

      const currentSize = fs.statSync(logPath).size;
      const rotatedSize = fs.statSync(rotatedPath).size;

      // Current log should be smaller (just the recent writes after rotation)
      assert.ok(currentSize < rotatedSize, 'current log should be smaller than rotated file');
      assert.ok(rotatedSize >= testCap, 'rotated file should be at or above the cap');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
