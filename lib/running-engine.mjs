/*
 * Running Engine — same pause/resume/restart/end architecture as the
 * strength WorkoutEngine, applied to segment-based (walk/run/interval)
 * treadmill and outdoor sessions. Timestamp-based via PausableTimer so a
 * locked screen or backgrounded tab never corrupts distance or pace.
 */
import { PausableTimer } from './timer-engine.mjs';

export const RunStatus = Object.freeze({
  IDLE: 'IDLE',
  ACTIVE: 'ACTIVE',
  PAUSED: 'PAUSED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
});

function newSessionId() {
  return 'run_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

/** segments: [{ type: 'walk'|'run'|'jog'|'interval', sec, speed }] — speed in km/h or mph, unit-agnostic. */
export class RunEngine {
  constructor() { this.reset(); }

  reset() {
    this.status = RunStatus.IDLE;
    this.sessionId = null;
    this.segments = [];
    this.idx = 0;
    this.completedKm = 0;
    this.continuousStreakSec = 0;
    this.longestContinuousSec = 0;
    this.runTimer = new PausableTimer();
    this.segmentTimer = new PausableTimer();
    this.sessionVersion = 0;
    this.abandonedFromSessionId = null;
  }

  currentSegment() { return this.segments[this.idx] || null; }

  startRun(segments, now = Date.now()) {
    this.reset();
    this.segments = segments;
    this.sessionId = newSessionId();
    this.status = RunStatus.ACTIVE;
    this.runTimer.start(now);
    this.segmentTimer.start(now);
    this.sessionVersion++;
    return this.getRunState(now);
  }

  pauseRun(now = Date.now()) {
    if (this.status !== RunStatus.ACTIVE) return this.getRunState(now);
    this.status = RunStatus.PAUSED;
    this.runTimer.pause(now);
    this.segmentTimer.pause(now);
    this.sessionVersion++;
    return this.getRunState(now);
  }

  resumeRun(now = Date.now()) {
    if (this.status !== RunStatus.PAUSED) return this.getRunState(now);
    this.status = RunStatus.ACTIVE;
    this.runTimer.resume(now);
    this.segmentTimer.resume(now);
    this.sessionVersion++;
    return this.getRunState(now);
  }

  restartRun(now = Date.now()) {
    const previousSnapshot = this.serialize();
    const segments = this.segments;
    this.startRun(segments, now);
    this.abandonedFromSessionId = previousSnapshot.sessionId;
    return { state: this.getRunState(now), previousSnapshot };
  }

  endRun(mode, now = Date.now()) {
    this.runTimer.stop(now);
    this.segmentTimer.stop(now);
    this.status = mode === 'discard' ? RunStatus.CANCELLED : RunStatus.COMPLETED;
    this.sessionVersion++;
    return this.getRunState(now);
  }

  /** Advances past any segment whose duration has fully elapsed. Call this
   *  on every UI tick; timestamps (not tick count) decide whether a
   *  segment boundary was crossed, so a delayed/throttled tick still lands
   *  on the correct segment. */
  tick(now = Date.now()) {
    if (this.status !== RunStatus.ACTIVE) return { advanced: false, finished: false, state: this.getRunState(now) };
    let advanced = false;
    while (this.status === RunStatus.ACTIVE) {
      const seg = this.currentSegment();
      if (!seg) break;
      const segElapsed = this.segmentTimer.elapsedSeconds(now);
      if (segElapsed < seg.sec) break;
      // The next segment's clock starts at the exact scheduled boundary
      // (previous start + its duration), not at `now` — otherwise a single
      // delayed tick that crosses two boundaries would zero out elapsed
      // time for every segment after the first instead of compounding it.
      const boundaryAt = this.segmentTimer.startedAt + seg.sec * 1000;
      this._completeCurrentSegment(seg, now);
      advanced = true;
      if (this.idx >= this.segments.length) {
        this.status = RunStatus.COMPLETED;
        this.runTimer.stop(now);
        this.sessionVersion++;
        return { advanced, finished: true, state: this.getRunState(now) };
      }
      this.segmentTimer.start(boundaryAt);
    }
    return { advanced, finished: false, state: this.getRunState(now) };
  }

  _completeCurrentSegment(seg, now) {
    this.completedKm += seg.speed * (seg.sec / 3600);
    if (seg.type !== 'walk') {
      this.continuousStreakSec += seg.sec;
      this.longestContinuousSec = Math.max(this.longestContinuousSec, this.continuousStreakSec);
    } else {
      this.continuousStreakSec = 0;
    }
    this.idx++;
    this.sessionVersion++;
  }

  skipSegment(now = Date.now()) {
    if (this.status !== RunStatus.ACTIVE) return this.getRunState(now);
    const seg = this.currentSegment();
    if (!seg) return this.getRunState(now);
    this._completeCurrentSegment(seg, now);
    if (this.idx >= this.segments.length) {
      this.status = RunStatus.COMPLETED;
      this.runTimer.stop(now);
    } else {
      this.segmentTimer.start(now);
    }
    this.sessionVersion++;
    return this.getRunState(now);
  }

  getRunState(now = Date.now()) {
    const seg = this.currentSegment();
    const segElapsed = this.segmentTimer.elapsedSeconds(now);
    const partialKm = seg ? seg.speed * (segElapsed / 3600) : 0;
    const liveStreak = this.continuousStreakSec + (seg && seg.type !== 'walk' ? segElapsed : 0);
    return {
      status: this.status,
      sessionId: this.sessionId,
      idx: this.idx,
      segments: this.segments,
      currentSegment: seg,
      segmentElapsedSeconds: segElapsed,
      segmentRemainingSeconds: seg ? Math.max(0, seg.sec - segElapsed) : 0,
      elapsedActiveSeconds: this.runTimer.elapsedSeconds(now),
      distanceKm: Math.round((this.completedKm + partialKm) * 100) / 100,
      longestContinuousSeconds: Math.max(this.longestContinuousSec, liveStreak),
      sessionVersion: this.sessionVersion,
    };
  }

  serialize() {
    return {
      status: this.status,
      sessionId: this.sessionId,
      segments: this.segments,
      idx: this.idx,
      completedKm: this.completedKm,
      continuousStreakSec: this.continuousStreakSec,
      longestContinuousSec: this.longestContinuousSec,
      runTimer: this.runTimer.toJSON(),
      segmentTimer: this.segmentTimer.toJSON(),
      sessionVersion: this.sessionVersion,
      lastUpdatedAt: Date.now(),
    };
  }

  static restore(json) {
    const engine = new RunEngine();
    if (!json) return engine;
    engine.status = json.status ?? RunStatus.IDLE;
    engine.sessionId = json.sessionId ?? null;
    engine.segments = json.segments ?? [];
    engine.idx = json.idx ?? 0;
    engine.completedKm = json.completedKm ?? 0;
    engine.continuousStreakSec = json.continuousStreakSec ?? 0;
    engine.longestContinuousSec = json.longestContinuousSec ?? 0;
    engine.runTimer = PausableTimer.fromJSON(json.runTimer);
    engine.segmentTimer = PausableTimer.fromJSON(json.segmentTimer);
    engine.sessionVersion = json.sessionVersion ?? 0;
    return engine;
  }

  isRecoverable() {
    return this.status !== RunStatus.COMPLETED && this.status !== RunStatus.CANCELLED && this.status !== RunStatus.IDLE;
  }
}
