/*
 * Timer Engine — timestamp-based, background/throttle-safe timers.
 *
 * setInterval()/setTimeout() drift or get throttled when a tab is
 * backgrounded, the phone screen locks, or the device sleeps. This engine
 * never trusts the tick count: elapsed/remaining time is always derived
 * from real timestamps (startedAt, pausedAt, accumulatedPausedMs), so a
 * timer that hasn't ticked in ten minutes still reports the correct
 * elapsed time the moment it's asked.
 *
 * Callers still use setInterval/requestAnimationFrame to know *when* to
 * re-render, but never to compute *what* to render.
 */

export const TimerStatus = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused',
  STOPPED: 'stopped',
});

export class PausableTimer {
  constructor() {
    this.status = TimerStatus.IDLE;
    this.startedAt = null;
    this.pausedAt = null;
    this.accumulatedPausedMs = 0;
    this.stoppedAt = null;
  }

  start(now = Date.now()) {
    this.status = TimerStatus.RUNNING;
    this.startedAt = now;
    this.pausedAt = null;
    this.accumulatedPausedMs = 0;
    this.stoppedAt = null;
    return this;
  }

  pause(now = Date.now()) {
    if (this.status !== TimerStatus.RUNNING) return this;
    this.status = TimerStatus.PAUSED;
    this.pausedAt = now;
    return this;
  }

  resume(now = Date.now()) {
    if (this.status !== TimerStatus.PAUSED) return this;
    this.accumulatedPausedMs += now - this.pausedAt;
    this.pausedAt = null;
    this.status = TimerStatus.RUNNING;
    return this;
  }

  stop(now = Date.now()) {
    if (this.status === TimerStatus.PAUSED) {
      // freeze paused duration accounting even if stopped without a resume
      this.accumulatedPausedMs += now - this.pausedAt;
      this.pausedAt = null;
    }
    this.status = TimerStatus.STOPPED;
    this.stoppedAt = now;
    return this;
  }

  reset() {
    this.status = TimerStatus.IDLE;
    this.startedAt = null;
    this.pausedAt = null;
    this.accumulatedPausedMs = 0;
    this.stoppedAt = null;
    return this;
  }

  isRunning() { return this.status === TimerStatus.RUNNING; }
  isPaused() { return this.status === TimerStatus.PAUSED; }

  elapsedMs(now = Date.now()) {
    if (this.startedAt == null) return 0;
    const end =
      this.status === TimerStatus.PAUSED ? this.pausedAt :
      this.status === TimerStatus.STOPPED ? this.stoppedAt :
      now;
    return Math.max(0, end - this.startedAt - this.accumulatedPausedMs);
  }

  elapsedSeconds(now) { return this.elapsedMs(now) / 1000; }

  remainingMs(totalMs, now = Date.now()) {
    return Math.max(0, totalMs - this.elapsedMs(now));
  }

  remainingSeconds(totalSec, now) { return this.remainingMs(totalSec * 1000, now) / 1000; }

  toJSON() {
    return {
      status: this.status,
      startedAt: this.startedAt,
      pausedAt: this.pausedAt,
      accumulatedPausedMs: this.accumulatedPausedMs,
      stoppedAt: this.stoppedAt,
    };
  }

  static fromJSON(json) {
    const t = new PausableTimer();
    if (!json) return t;
    t.status = json.status ?? TimerStatus.IDLE;
    t.startedAt = json.startedAt ?? null;
    t.pausedAt = json.pausedAt ?? null;
    t.accumulatedPausedMs = json.accumulatedPausedMs ?? 0;
    t.stoppedAt = json.stoppedAt ?? null;
    return t;
  }
}
