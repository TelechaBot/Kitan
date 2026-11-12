// The trajectory sketch and the isolation forest on synthetic accounts. Synthetic data
// shows the mechanism works, not how it does on real groups; that is what replay on
// production footprints measures.
import { describe, expect, test } from "bun:test";
import { score, train } from "../src/iforest";
import { type Activity, FEATURES, type Trajectory, empty, features, step } from "../src/trajectory";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 1);

function play(events: Activity[]): Trajectory {
  return events.reduce(step, empty());
}

const say = (at: number, o: Partial<Extract<Activity, { kind: "message" }>> = {}): Activity => ({
  kind: "message", at, newChat: false, link: false, mention: false, forward: false, media: false, chars: 20, ...o,
});

// A person: a few messages a day at irregular times in their evening, now and then a link.
function person(seed: number): Activity[] {
  let s = seed;
  const r = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const events: Activity[] = [{ kind: "join", at: T0 }];
  let at = T0 + (2 + r() * 48) * HOUR;
  for (let i = 0; i < 40; i++) {
    const day = Math.floor((at - T0) / (24 * HOUR));
    at = T0 + day * 24 * HOUR + (12 + r() * 10) * HOUR + r() * 24 * HOUR * (r() < 0.3 ? 1 : 0);
    events.push(say(at, { newChat: i === 0, link: r() < 0.05, mention: r() < 0.1, chars: 5 + Math.floor(r() * 60), media: r() < 0.1 }));
    at += r() * 6 * HOUR;
  }
  return events;
}

// A farmed account: joins, greets on a timer around the clock, then switches to links.
function farmed(): Activity[] {
  const events: Activity[] = [{ kind: "join", at: T0 }];
  for (let i = 0; i < 36; i++) events.push(say(T0 + 60_000 + i * 2 * HOUR, { newChat: i === 0, chars: 8 }));
  for (let i = 0; i < 4; i++) events.push(say(T0 + 73 * HOUR + i * 5_000, { link: true, mention: true, chars: 120 }));
  return events;
}

describe("trajectory sketch", () => {
  test("one value per named feature", () => {
    expect(features(play(person(1)), 7e9, T0 + 30 * 24 * HOUR)).toHaveLength(FEATURES.length);
  });

  test("the switch from greetings to links shows as a shift between recent and usual", () => {
    const f = features(play(farmed()), 8.9e9, T0 + 4 * 24 * HOUR);
    expect(f[FEATURES.indexOf("shift_link")]).toBeGreaterThan(0.5);
    expect(f[FEATURES.indexOf("burst_share")]).toBeGreaterThan(0);
    expect(f[FEATURES.indexOf("log_first_reply")]).toBeLessThan(Math.log1p(2));
  });

  test("time from joining to the first message is kept", () => {
    const t = play([{ kind: "join", at: T0 }, say(T0 + 30 * 60_000)]);
    expect(t.firstReplyMinutes).toBe(30);
  });
});

describe("isolation forest", () => {
  test("is reproducible from the same rows and seed", () => {
    const rows = Array.from({ length: 50 }, (_, i) => [i % 7, i % 3]);
    expect(score(train(rows, { seed: 3 }), [1, 1])).toBe(score(train(rows, { seed: 3 }), [1, 1]));
  });

  test("a farmed account scores above every ordinary person it was trained on", () => {
    const now = T0 + 30 * 24 * HOUR;
    const people = Array.from({ length: 200 }, (_, i) => features(play(person(i + 1)), 2e9 + i * 2e7, now));
    const forest = train(people, { seed: 7 });
    const ordinary = people.map((p) => score(forest, p)).sort((a, b) => a - b);
    const farm = score(forest, features(play(farmed()), 8.9e9, now));
    expect(farm).toBeGreaterThan(0.6);
    expect(farm).toBeGreaterThan(ordinary[Math.floor(ordinary.length * 0.99)]);
  });
});
