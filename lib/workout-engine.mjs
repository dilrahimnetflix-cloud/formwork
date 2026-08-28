/*
 * Workout Engine — the single source of truth for an in-progress workout.
 *
 * The UI (screens, buttons, camera, voice) must call this engine rather
 * than implementing pause/resume/rest/rep logic itself. It owns:
 *   - the workout state machine (status)
 *   - the current exercise/set/rep position
 *   - the workout-level timer and the per-rest timer (both timestamp
 *     based, via PausableTimer, so backgrounding/throttling never
 *     corrupts elapsed/remaining time)
 *   - a serializable snapshot for crash/interruption recovery
 *
 * It has no DOM, camera, or storage dependency, so it can run headless in
 * tests and be reused by any renderer.
 */
import { PausableTimer } from './timer-engine.mjs';

export const WorkoutStatus = Object.freeze({
  IDLE: 'IDLE',
  PREPARING: 'PREPARING',
  ACTIVE: 'ACTIVE',
  PAUSED: 'PAUSED',
  RESTING: 'RESTING',
  TRANSITIONING: 'TRANSITIONING',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  RESTARTING: 'RESTARTING',
  ERROR: 'ERROR',
});

const SCHEMA_VERSION = 1;

function newSessionId() {
  return 'wk_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

/**
 * plan: array of { exId, sets, reps?, holdSec?, restSec, weight? }
 * opts: { totalDurationEstimateSec, transitionRestSec, userId, workoutId }
 */
export class WorkoutEngine {
  constructor() {
    this.reset();
  }

  reset() {
    this.status = WorkoutStatus.IDLE;
    this.sessionId = null;
    this.userId = null;
    this.workoutId = null;
    this.plan = [];
    this.exerciseIndex = 0;
    this.setIndex = 1; // 1-based, matches "SET 2 / 3" UI language
    this.currentReps = 0;
    this.currentWeight = null;
    this.currentRPE = null;
    this.currentRIR = null;
    this.pausedFrom = null; // 'ACTIVE' | 'RESTING' — where PAUSED should resume to
    this.restDurationSec = 0;
    this.transitionRestSec = 30;
    this.totalDurationEstimateSec = 0;
    this.sessionLogs = [];
    this.startedAt = null;
    this.workoutTimer = new PausableTimer();
    this.restTimer = new PausableTimer();
    this.cameraStatus = 'inactive';
    this.sessionVersion = 0;
    this.abandonedFromSessionId = null;
  }

  // ---- lifecycle -----------------------------------------------------

  startWorkout(plan, opts = {}, now = Date.now()) {
    this.reset();
    this.plan = plan;
    this.userId = opts.userId ?? null;
    this.workoutId = opts.workoutId ?? null;
    this.totalDurationEstimateSec = opts.totalDurationEstimateSec ?? 0;
    this.transitionRestSec = opts.transitionRestSec ?? 30;
    this.sessionId = newSessionId();
    this.startedAt = now;
    this.status = WorkoutStatus.ACTIVE;
    this.workoutTimer.start(now);
    this.sessionVersion++;
    return this.getState(now);
  }

  pauseWorkout(now = Date.now()) {
    if (this.status !== WorkoutStatus.ACTIVE && this.status !== WorkoutStatus.RESTING) {
      return this.getState(now);
    }
    this.pausedFrom = this.status;
    this.status = WorkoutStatus.PAUSED;
    this.workoutTimer.pause(now);
    if (this.pausedFrom === WorkoutStatus.RESTING) this.restTimer.pause(now);
    this.cameraStatus = 'inactive';
    this.sessionVersion++;
    return this.getState(now);
  }

  resumeWorkout(now = Date.now()) {
    if (this.status !== WorkoutStatus.PAUSED) return this.getState(now);
    this.status = this.pausedFrom || WorkoutStatus.ACTIVE;
    this.workoutTimer.resume(now);
    if (this.status === WorkoutStatus.RESTING) this.restTimer.resume(now);
    this.pausedFrom = null;
    this.sessionVersion++;
    return this.getState(now);
  }

  /** Discards current progress and starts the same plan over. Returns the
   *  pre-restart snapshot so the caller can record it as an abandoned
   *  attempt in history — restarting must never silently corrupt or lose
   *  that record. */
  restartWorkout(now = Date.now()) {
    const previousSnapshot = this.serialize();
    const plan = this.plan;
    const opts = {
      userId: this.userId,
      workoutId: this.workoutId,
      totalDurationEstimateSec: this.totalDurationEstimateSec,
      transitionRestSec: this.transitionRestSec,
    };
    this.startWorkout(plan, opts, now);
    this.abandonedFromSessionId = previousSnapshot.sessionId;
    return { state: this.getState(now), previousSnapshot };
  }

  /** mode: 'save' preserves sessionLogs as an incomplete-but-saved session;
   *  'discard' cancels the live session without touching workout history. */
  endWorkout(mode, now = Date.now()) {
    this.workoutTimer.stop(now);
    this.restTimer.stop(now);
    this.status = mode === 'discard' ? WorkoutStatus.CANCELLED : WorkoutStatus.COMPLETED;
    this.cameraStatus = 'inactive';
    this.sessionVersion++;
    return this.getState(now);
  }

  // ---- set / rest / exercise progression ------------------------------

  currentPlanEntry() { return this.plan[this.exerciseIndex] || null; }

  /** Only counts while the set is actually active — never while paused,
   *  resting, or after the exercise finished. */
  recordRep(now = Date.now()) {
    if (this.status !== WorkoutStatus.ACTIVE) return this.getState(now);
    this.currentReps++;
    return this.getState(now);
  }

  setReps(count, now = Date.now()) {
    if (this.status !== WorkoutStatus.ACTIVE) return this.getState(now);
    this.currentReps = Math.max(0, count);
    return this.getState(now);
  }

  /** result: { reps?, holdSec?, formPct?, rpe?, rir? } */
  completeSet(result = {}, now = Date.now()) {
    if (this.status !== WorkoutStatus.ACTIVE) return { finished: false, state: this.getState(now) };
    const entry = this.currentPlanEntry();
    this.sessionLogs.push({
      exId: entry?.exId,
      setNum: this.setIndex,
      reps: result.reps ?? this.currentReps,
      target: entry?.reps ?? null,
      holdSec: result.holdSec ?? null,
      formPct: result.formPct ?? null,
      rpe: result.rpe ?? this.currentRPE,
      rir: result.rir ?? this.currentRIR,
      completedAt: now,
    });
    this.currentReps = 0;

    const isLastSet = this.setIndex >= (entry?.sets ?? 1);
    const isLastExercise = this.exerciseIndex >= this.plan.length - 1;

    if (!isLastSet) {
      this.setIndex++;
      this._beginRest(entry?.restSec ?? 60, false, now);
      return { finished: false, state: this.getState(now) };
    }
    if (!isLastExercise) {
      this.exerciseIndex++;
      this.setIndex = 1;
      this._beginRest(this.transitionRestSec, true, now);
      return { finished: false, state: this.getState(now) };
    }
    // Last set of last exercise — the workout itself is done.
    this.status = WorkoutStatus.COMPLETED;
    this.workoutTimer.stop(now);
    this.sessionVersion++;
    return { finished: true, state: this.getState(now) };
  }

  _beginRest(restSec, isNewExercise, now) {
    this.restDurationSec = restSec;
    this.restNextIsNewExercise = isNewExercise;
    this.status = WorkoutStatus.RESTING;
    this.restTimer.start(now);
    this.sessionVersion++;
  }

  skipRest(now = Date.now()) {
    if (this.status !== WorkoutStatus.RESTING) return this.getState(now);
    this.restTimer.stop(now);
    this.status = WorkoutStatus.ACTIVE;
    this.sessionVersion++;
    return this.getState(now);
  }

  /** Resets the current rest period back to full duration, without
   *  touching workout progress — distinct from restartWorkout(). */
  restartRest(now = Date.now()) {
    if (this.status !== WorkoutStatus.RESTING) return this.getState(now);
    this.restTimer.start(now);
    this.sessionVersion++;
    return this.getState(now);
  }

  addRestSeconds(deltaSec, now = Date.now()) {
    this.restDurationSec = Math.max(0, this.restDurationSec + deltaSec);
    this.sessionVersion++;
    return this.getState(now);
  }

  skipExercise(now = Date.now()) {
    if (this.status !== WorkoutStatus.ACTIVE && this.status !== WorkoutStatus.RESTING) {
      return this.getState(now);
    }
    this.restTimer.stop(now);
    this.currentReps = 0;
    if (this.exerciseIndex < this.plan.length - 1) {
      this.exerciseIndex++;
      this.setIndex = 1;
      this.status = WorkoutStatus.ACTIVE;
    } else {
      this.status = WorkoutStatus.COMPLETED;
      this.workoutTimer.stop(now);
    }
    this.sessionVersion++;
    return this.getState(now);
  }

  replaceExercise(newExId) {
    const entry = this.currentPlanEntry();
    if (entry) entry.exId = newExId;
    this.sessionVersion++;
    return this.getState();
  }

  adjustWeight(newWeight) {
    this.currentWeight = newWeight;
    const entry = this.currentPlanEntry();
    if (entry) entry.weight = newWeight;
    this.sessionVersion++;
    return this.getState();
  }

  // ---- derived state / persistence ------------------------------------

  getState(now = Date.now()) {
    const elapsedSeconds = this.workoutTimer.elapsedSeconds(now);
    return {
      status: this.status,
      sessionId: this.sessionId,
      pausedFrom: this.pausedFrom,
      exerciseIndex: this.exerciseIndex,
      setIndex: this.setIndex,
      currentReps: this.currentReps,
      currentWeight: this.currentWeight,
      plan: this.plan,
      currentExercise: this.currentPlanEntry(),
      elapsedSeconds,
      remainingSeconds: Math.max(0, this.totalDurationEstimateSec - elapsedSeconds),
      restDurationSec: this.restDurationSec,
      restElapsedSeconds: this.restTimer.elapsedSeconds(now),
      restRemainingSeconds: this.restTimer.remainingSeconds(this.restDurationSec, now),
      restNextIsNewExercise: !!this.restNextIsNewExercise,
      sessionLogs: this.sessionLogs,
      cameraStatus: this.cameraStatus,
      sessionVersion: this.sessionVersion,
    };
  }

  serialize() {
    return {
      schemaVersion: SCHEMA_VERSION,
      status: this.status,
      sessionId: this.sessionId,
      userId: this.userId,
      workoutId: this.workoutId,
      plan: this.plan,
      exerciseIndex: this.exerciseIndex,
      setIndex: this.setIndex,
      currentReps: this.currentReps,
      currentWeight: this.currentWeight,
      currentRPE: this.currentRPE,
      currentRIR: this.currentRIR,
      pausedFrom: this.pausedFrom,
      restDurationSec: this.restDurationSec,
      restNextIsNewExercise: !!this.restNextIsNewExercise,
      transitionRestSec: this.transitionRestSec,
      totalDurationEstimateSec: this.totalDurationEstimateSec,
      sessionLogs: this.sessionLogs,
      startedAt: this.startedAt,
      workoutTimer: this.workoutTimer.toJSON(),
      restTimer: this.restTimer.toJSON(),
      sessionVersion: this.sessionVersion,
      lastUpdatedAt: Date.now(),
    };
  }

  /** Restores an exact prior session — used for interruption recovery
   *  (screen lock, backgrounding, refresh, network loss). Never silently
   *  discards; the caller decides whether to resume or restart. */
  static restore(json) {
    const engine = new WorkoutEngine();
    if (!json) return engine;
    engine.status = json.status ?? WorkoutStatus.IDLE;
    engine.sessionId = json.sessionId ?? null;
    engine.userId = json.userId ?? null;
    engine.workoutId = json.workoutId ?? null;
    engine.plan = json.plan ?? [];
    engine.exerciseIndex = json.exerciseIndex ?? 0;
    engine.setIndex = json.setIndex ?? 1;
    engine.currentReps = json.currentReps ?? 0;
    engine.currentWeight = json.currentWeight ?? null;
    engine.currentRPE = json.currentRPE ?? null;
    engine.currentRIR = json.currentRIR ?? null;
    engine.pausedFrom = json.pausedFrom ?? null;
    engine.restDurationSec = json.restDurationSec ?? 0;
    engine.restNextIsNewExercise = !!json.restNextIsNewExercise;
    engine.transitionRestSec = json.transitionRestSec ?? 30;
    engine.totalDurationEstimateSec = json.totalDurationEstimateSec ?? 0;
    engine.sessionLogs = json.sessionLogs ?? [];
    engine.startedAt = json.startedAt ?? null;
    engine.workoutTimer = PausableTimer.fromJSON(json.workoutTimer);
    engine.restTimer = PausableTimer.fromJSON(json.restTimer);
    engine.sessionVersion = json.sessionVersion ?? 0;
    return engine;
  }

  /** Call when the app is backgrounded/screen-locked mid-workout. Distinct
   *  from a user-initiated pause only in that the reason is recorded —
   *  behaviour (freeze everything, stop camera) is identical. */
  pauseForInterruption(now = Date.now()) {
    return this.pauseWorkout(now);
  }

  isRecoverable() {
    return this.status !== WorkoutStatus.COMPLETED && this.status !== WorkoutStatus.CANCELLED && this.status !== WorkoutStatus.IDLE;
  }
}
