import test from 'node:test';
import assert from 'node:assert/strict';
import { RunEngine, RunStatus } from '../lib/running-engine.mjs';

function segments() {
  return [
    { type: 'walk', sec: 60, speed: 4.5 },
    { type: 'run', sec: 120, speed: 8 },
    { type: 'walk', sec: 60, speed: 4.5 },
  ];
}

test('run pause/resume preserves distance, segment and elapsed time exactly', () => {
  const engine = new RunEngine();
  engine.startRun(segments(), 0);
  engine.tick(30000); // 30s into the walk segment
  const beforePause = engine.getRunState(30000);
  assert.equal(beforePause.idx, 0);
  assert.ok(beforePause.distanceKm > 0);

  engine.pauseRun(30000);
  const paused = engine.getRunState(30000);
  assert.equal(paused.status, RunStatus.PAUSED);

  // Ten minutes pass with the screen locked — nothing should move.
  const stillPaused = engine.getRunState(30000 + 10 * 60 * 1000);
  assert.equal(stillPaused.distanceKm, paused.distanceKm, 'distance must freeze while paused');
  assert.equal(stillPaused.segmentRemainingSeconds, paused.segmentRemainingSeconds);
  assert.equal(stillPaused.elapsedActiveSeconds, paused.elapsedActiveSeconds);

  engine.resumeRun(30000 + 10 * 60 * 1000);
  const resumed = engine.getRunState(30000 + 10 * 60 * 1000 + 5000); // 5s after resume
  assert.equal(resumed.segmentElapsedSeconds, 35, '30s before pause + 5s after resume, excluding the paused gap');
});

test('tick advances across segment boundaries based on elapsed time, not tick count', () => {
  const engine = new RunEngine();
  engine.startRun(segments(), 0);
  // Simulate a single delayed tick landing well past two segment boundaries.
  const result = engine.tick(60000 + 120000 + 10000); // 60s walk + 120s run + 10s into final walk
  assert.equal(result.advanced, true);
  assert.equal(engine.idx, 2, 'should have advanced past both completed segments to the final one');
  assert.equal(Math.round(engine.getRunState(190000).segmentElapsedSeconds), 10);
});

test('longest continuous run streak accumulates across non-walk segments and resets on walk', () => {
  const engine = new RunEngine();
  engine.startRun([
    { type: 'walk', sec: 30, speed: 4.5 },
    { type: 'run', sec: 60, speed: 8 },
    { type: 'run', sec: 60, speed: 9 },
    { type: 'walk', sec: 30, speed: 4.5 },
  ], 0);
  engine.tick(30000 + 60000 + 60000 + 5000); // through both run segments, 5s into final walk
  const state = engine.getRunState(30000 + 60000 + 60000 + 5000);
  assert.equal(state.longestContinuousSeconds, 120, 'two consecutive run segments combine into one streak');
});

test('restart discards the live run but keeps the previous attempt recoverable for history', () => {
  const engine = new RunEngine();
  engine.startRun(segments(), 0);
  engine.tick(90000);
  const { state, previousSnapshot } = engine.restartRun(200000);
  assert.ok(previousSnapshot.completedKm > 0 || previousSnapshot.idx > 0, 'previous attempt progress is captured before reset');
  assert.equal(state.idx, 0);
  assert.equal(state.distanceKm, 0);
  assert.notEqual(previousSnapshot.sessionId, state.sessionId);
});

test('end run save vs discard both stop the timer; only discard is meant to be thrown away by the caller', () => {
  const engine = new RunEngine();
  engine.startRun(segments(), 0);
  engine.tick(30000);
  const saved = engine.endRun('save', 30000);
  assert.equal(saved.status, RunStatus.COMPLETED);

  const engine2 = new RunEngine();
  engine2.startRun(segments(), 0);
  engine2.tick(30000);
  const discarded = engine2.endRun('discard', 30000);
  assert.equal(discarded.status, RunStatus.CANCELLED);
});

test('serialize/restore recovers exact segment index, distance and elapsed time after an interruption', () => {
  const engine = new RunEngine();
  engine.startRun(segments(), 0);
  engine.tick(75000); // 60s walk done, 15s into the run segment
  const snapshot = JSON.parse(JSON.stringify(engine.serialize()));
  const restored = RunEngine.restore(snapshot);
  assert.equal(restored.isRecoverable(), true);
  const state = restored.getRunState(75000);
  assert.equal(state.idx, 1);
  assert.equal(Math.round(state.segmentElapsedSeconds), 15);
});

test('completing the final segment finishes the run', () => {
  const engine = new RunEngine();
  engine.startRun([{ type: 'run', sec: 10, speed: 8 }], 0);
  const result = engine.tick(10000);
  assert.equal(result.finished, true);
  assert.equal(engine.status, RunStatus.COMPLETED);
});
