import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkoutEngine, WorkoutStatus } from '../lib/workout-engine.mjs';

function samplePlan() {
  return [
    { exId: 'gobletSquat', sets: 3, reps: 10, restSec: 60 },
    { exId: 'romanianDeadlift', sets: 3, reps: 10, restSec: 60 },
  ];
}

// The exact scenario from the master spec's "test this exact scenario" section:
// start -> 7/10 reps -> pause -> verify frozen -> resume -> finish set -> rest ->
// pause rest -> resume rest -> finish rest -> next set -> restart -> end.
test('full workout journey: pause/resume/restart/end preserve or reset state correctly', () => {
  const engine = new WorkoutEngine();
  engine.startWorkout(samplePlan(), { totalDurationEstimateSec: 1800 }, 0);
  assert.equal(engine.status, WorkoutStatus.ACTIVE);

  // 1-3: complete 7 of 10 reps
  for (let i = 0; i < 7; i++) engine.recordRep(1000 + i * 100);
  assert.equal(engine.getState(1700).currentReps, 7);

  // 4-5: pause and verify rep count + elapsed time freeze
  engine.pauseWorkout(2000);
  const pausedState = engine.getState(2000);
  assert.equal(pausedState.status, WorkoutStatus.PAUSED);
  assert.equal(pausedState.currentReps, 7, 'rep count must survive pause exactly');
  assert.equal(pausedState.elapsedSeconds, 2, 'elapsed time at pause = 2s (paused at t=2000, started at t=0)');
  // Time passes for ten minutes while paused (phone locked) — nothing should move.
  const stillPaused = engine.getState(2000 + 10 * 60 * 1000);
  assert.equal(stillPaused.currentReps, 7);
  assert.equal(stillPaused.elapsedSeconds, 2, 'elapsed time must not advance while paused, however long the gap');
  // Reps must not be recordable while paused (no accidental counting).
  engine.recordRep(2500);
  assert.equal(engine.getState(2500).currentReps, 7, 'a rep fired while paused must not count');

  // 6: resume — continues from the exact same state
  engine.resumeWorkout(605000);
  const resumedState = engine.getState(605000);
  assert.equal(resumedState.status, WorkoutStatus.ACTIVE);
  assert.equal(resumedState.currentReps, 7);
  assert.equal(resumedState.elapsedSeconds, 2, 'elapsed time excludes the ~603s pause duration');

  // 7-8: complete remaining reps and finish the set
  for (let i = 0; i < 3; i++) engine.recordRep(605100 + i * 100);
  assert.equal(engine.getState(605500).currentReps, 10);
  const setResult = engine.completeSet({ reps: 10, formPct: 91 }, 605600);
  assert.equal(setResult.finished, false);
  assert.equal(setResult.state.status, WorkoutStatus.RESTING);
  assert.equal(setResult.state.setIndex, 2, 'advances to set 2 of 3');
  assert.equal(setResult.state.currentReps, 0, 'rep counter resets for the next set');
  assert.equal(engine.sessionLogs.length, 1);
  assert.equal(engine.sessionLogs[0].reps, 10);

  // 9-11: rest timer runs, then pause during rest freezes remaining rest time
  let restState = engine.getState(605600 + 20000); // 20s into a 60s rest
  assert.equal(Math.round(restState.restRemainingSeconds), 40);
  engine.pauseWorkout(605600 + 22000);
  const pausedInRest = engine.getState(605600 + 22000);
  assert.equal(pausedInRest.status, WorkoutStatus.PAUSED);
  assert.equal(pausedInRest.pausedFrom, WorkoutStatus.RESTING);
  assert.equal(Math.round(pausedInRest.restRemainingSeconds), 38);
  // Long gap while paused during rest — remaining rest must not drain to zero.
  const longGapDuringRestPause = engine.getState(605600 + 22000 + 5 * 60 * 1000);
  assert.equal(Math.round(longGapDuringRestPause.restRemainingSeconds), 38, 'rest must freeze, not silently expire, while paused');

  // 12: resume rest — continues the same countdown, not a fresh one
  engine.resumeWorkout(605600 + 25000);
  const resumedRest = engine.getState(605600 + 25000);
  assert.equal(resumedRest.status, WorkoutStatus.RESTING);
  assert.equal(Math.round(resumedRest.restRemainingSeconds), 38);

  // 13-14: rest completes naturally -> next set begins
  engine.skipRest(605600 + 25000 + 38000);
  assert.equal(engine.getState().status, WorkoutStatus.ACTIVE);
  assert.equal(engine.getState().setIndex, 2);

  // 15-16: RESTART discards all progress and returns to the very beginning
  const { state: restartedState, previousSnapshot } = engine.restartWorkout(900000);
  assert.equal(previousSnapshot.sessionLogs.length, 1, 'the pre-restart attempt is captured, not silently lost');
  assert.notEqual(previousSnapshot.sessionId, restartedState.sessionId, 'restart starts a distinct session id');
  assert.equal(restartedState.status, WorkoutStatus.ACTIVE);
  assert.equal(restartedState.exerciseIndex, 0);
  assert.equal(restartedState.setIndex, 1);
  assert.equal(restartedState.currentReps, 0);
  assert.equal(restartedState.elapsedSeconds, 0);
  assert.equal(restartedState.sessionLogs.length, 0, 'restart clears the live session logs (history keeps the previous snapshot separately)');

  // 17-18: END WORKOUT with an incomplete session must be handled explicitly (save vs discard)
  engine.recordRep(900100);
  const savedIncomplete = engine.endWorkout('save', 905000);
  assert.equal(savedIncomplete.status, WorkoutStatus.COMPLETED);
  assert.equal(savedIncomplete.currentReps, 1, 'save & exit preserves what was logged so far');
});

test('discarding a workout cancels the live session without needing to touch history', () => {
  const engine = new WorkoutEngine();
  engine.startWorkout(samplePlan(), {}, 0);
  engine.completeSet({ reps: 10 }, 1000);
  const state = engine.endWorkout('discard', 2000);
  assert.equal(state.status, WorkoutStatus.CANCELLED);
  // The engine itself never deletes sessionLogs on discard — the caller decides
  // whether/how to record the cancelled attempt; this only stops it from
  // continuing to run as if still active.
  assert.equal(engine.sessionLogs.length, 1);
});

test('19-21: refresh/backgrounding — serialize then restore recovers the exact exercise/set/rep state', () => {
  const engine = new WorkoutEngine();
  engine.startWorkout(samplePlan(), { totalDurationEstimateSec: 1800 }, 0);
  engine.completeSet({ reps: 10 }, 500); // -> set 2, resting
  for (let i = 0; i < 4; i++) engine.recordRep(600); // reps don't count while RESTING
  engine.skipRest(600);
  for (let i = 0; i < 4; i++) engine.recordRep(700 + i * 10);

  // Simulate an app kill / tab refresh: snapshot is the only thing that survives.
  const snapshot = JSON.parse(JSON.stringify(engine.serialize()));
  const restored = WorkoutEngine.restore(snapshot);

  assert.equal(restored.isRecoverable(), true);
  const state = restored.getState(1000);
  assert.equal(state.exerciseIndex, 0);
  assert.equal(state.setIndex, 2);
  assert.equal(state.currentReps, 4, 'exact rep count at time of interruption is restored');
  assert.equal(state.sessionLogs.length, 1);
});

test('a completed or cancelled session is not offered for recovery', () => {
  const engine = new WorkoutEngine();
  engine.startWorkout(samplePlan(), {}, 0);
  engine.endWorkout('discard', 100);
  assert.equal(engine.isRecoverable(), false);

  const engine2 = new WorkoutEngine();
  engine2.startWorkout(samplePlan(), {}, 0);
  engine2.endWorkout('save', 100);
  assert.equal(engine2.isRecoverable(), false);
});

test('completing the final set of the final exercise finishes the workout without an extra rest period', () => {
  const engine = new WorkoutEngine();
  engine.startWorkout([{ exId: 'plank', sets: 1, holdSec: 30, restSec: 45 }], {}, 0);
  const result = engine.completeSet({ holdSec: 30 }, 30000);
  assert.equal(result.finished, true);
  assert.equal(result.state.status, WorkoutStatus.COMPLETED);
});

test('pause is a no-op from IDLE/COMPLETED and resume is a no-op unless PAUSED', () => {
  const engine = new WorkoutEngine();
  engine.pauseWorkout(0); // never started
  assert.equal(engine.status, WorkoutStatus.IDLE);
  engine.startWorkout(samplePlan(), {}, 0);
  engine.resumeWorkout(100); // already active, not paused
  assert.equal(engine.status, WorkoutStatus.ACTIVE);
});

test('skipExercise moves on without logging a full set and camera is marked inactive on pause', () => {
  const engine = new WorkoutEngine();
  engine.startWorkout(samplePlan(), {}, 0);
  engine.cameraStatus = 'active';
  engine.pauseWorkout(100);
  assert.equal(engine.cameraStatus, 'inactive');
  engine.resumeWorkout(200);
  const state = engine.skipExercise(300);
  assert.equal(state.exerciseIndex, 1);
  assert.equal(state.setIndex, 1);
});

test('addRestSeconds and restartRest adjust only the rest period, not workout progress', () => {
  const engine = new WorkoutEngine();
  engine.startWorkout(samplePlan(), {}, 0);
  engine.completeSet({ reps: 10 }, 100); // -> RESTING, 60s
  engine.addRestSeconds(15, 200);
  assert.equal(engine.getState(200).restDurationSec, 75);
  engine.addRestSeconds(-15, 200);
  assert.equal(engine.getState(200).restDurationSec, 60);
  const midRest = engine.getState(30200); // 30s into rest
  assert.ok(midRest.restRemainingSeconds < 60 && midRest.restRemainingSeconds > 0);
  engine.restartRest(30200);
  assert.equal(Math.round(engine.getState(30200).restRemainingSeconds), 60);
  assert.equal(engine.exerciseIndex, 0, 'restartRest never touches exercise/set progress');
  assert.equal(engine.setIndex, 2);
});
