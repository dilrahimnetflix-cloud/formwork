import test from 'node:test';
import assert from 'node:assert/strict';
import { PausableTimer, TimerStatus } from '../lib/timer-engine.mjs';

test('elapsed time accrues while running', () => {
  const t = new PausableTimer();
  t.start(1000);
  assert.equal(t.elapsedMs(1000), 0);
  assert.equal(t.elapsedMs(5000), 4000);
});

test('pause freezes elapsed time exactly, even across a long real-world gap', () => {
  const t = new PausableTimer();
  t.start(0);
  t.pause(4000); // 4s in
  // Simulate the phone being locked for 10 minutes — no ticks fire at all.
  const muchLater = 4000 + 10 * 60 * 1000;
  assert.equal(t.elapsedMs(muchLater), 4000, 'paused timer must not advance no matter how long the gap');
});

test('resume excludes paused duration from elapsed time', () => {
  const t = new PausableTimer();
  t.start(0);
  t.pause(4000);
  t.resume(9000); // paused for 5s
  assert.equal(t.elapsedMs(10000), 4000 + 1000);
});

test('multiple pause/resume cycles accumulate correctly', () => {
  const t = new PausableTimer();
  t.start(0);
  t.pause(1000); // active 1s
  t.resume(2000); // paused 1s
  t.pause(4000); // active 2s more (total active 3s)
  t.resume(4500); // paused 0.5s more
  assert.equal(t.elapsedMs(5500), 3000 + 1000, '3s active before second pause + 1s active after resume');
});

test('remainingSeconds counts down and floors at zero', () => {
  const t = new PausableTimer();
  t.start(0);
  assert.equal(t.remainingSeconds(60, 10000), 50);
  assert.equal(t.remainingSeconds(60, 999999), 0);
});

test('stop freezes elapsed at stop time', () => {
  const t = new PausableTimer();
  t.start(0);
  t.stop(3000);
  assert.equal(t.elapsedMs(999999), 3000);
});

test('serialize/deserialize round-trips exactly (interruption recovery)', () => {
  const t = new PausableTimer();
  t.start(0);
  t.pause(2500);
  const json = JSON.parse(JSON.stringify(t.toJSON()));
  const restored = PausableTimer.fromJSON(json);
  assert.equal(restored.status, TimerStatus.PAUSED);
  assert.equal(restored.elapsedMs(999999), 2500);
});
