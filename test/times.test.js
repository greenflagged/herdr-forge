// Times in the viewer's zone. Node follows process.env.TZ when it changes, so each test
// sets the zone it means (node --test runs every file in its own process).
import assert from "node:assert/strict";
import { test } from "node:test";
import { agoAt, dateLabel, daysUntil, localDay, localTime, stamp, tzArg, zoneLabel } from "../shared/lib.js";
import { bucketLabel, rangeStart, DAY } from "../mods/forge-velocity/view.js";

const zone = (tz) => { process.env.TZ = tz; };
const NOW = Date.UTC(2026, 9, 31, 20, 40); // Sat Oct 31 2026, 1:40 PM in California (PDT)

test("zoneLabel follows the viewer's offset, DST included", () => {
  zone("America/Los_Angeles");
  assert.equal(zoneLabel(NOW), "UTC−7");
  assert.equal(zoneLabel(Date.UTC(2026, 0, 15)), "UTC−8", "winter is standard time");
  zone("Asia/Kolkata");
  assert.equal(zoneLabel(NOW), "UTC+5:30");
  zone("UTC");
  assert.equal(zoneLabel(NOW), "UTC");
});

test("localTime is the viewer's wall clock with its zone", () => {
  zone("America/Los_Angeles");
  assert.equal(localTime(NOW, NOW), "Oct 31, 1:40 PM UTC−7");
  assert.equal(localTime(Date.UTC(2026, 0, 15, 8, 5), NOW), "Jan 15, 12:05 AM UTC−8", "midnight hour is 12 AM");
  assert.equal(localTime(Date.UTC(2025, 6, 4, 19, 0), NOW), "Jul 4 2025, 12:00 PM UTC−7", "another year says so");
  assert.equal(localTime(null), "");
  zone("Europe/Berlin");
  assert.equal(localTime(NOW, NOW), "Oct 31, 9:40 PM UTC+1", "Berlin left DST a week earlier");
});

test("stamp and agoAt remember localTime for tooltips", () => {
  zone("America/Los_Angeles");
  const t = Date.UTC(2026, 9, 30, 1, 2);
  assert.equal(stamp(t), localTime(t));
  assert.equal(stamp(t), localTime(t), "a second call answers from memory");
  assert.equal(stamp(null), "");
  assert.equal(agoAt(NOW - 2 * 3600000, NOW), `2h ago (${stamp(NOW - 2 * 3600000)})`);
  assert.match(agoAt(NOW - 1000, NOW), /^just now \(/);
});

test("due dates are calendar days, never shifted by UTC parsing", () => {
  zone("America/Los_Angeles");
  // 11:30 PM on Oct 31 in California is already Nov 1 in UTC: still one day to go.
  const late = Date.UTC(2026, 10, 1, 6, 30);
  assert.equal(daysUntil("2026-11-01", late), 1);
  assert.equal(daysUntil("2026-10-31", late), 0);
  assert.equal(daysUntil("2026-10-29", late), -2);
  assert.equal(daysUntil("2026-11-08", NOW), 8, "the DST change on Nov 1 doesn't make it 7.96");
  assert.equal(daysUntil(null, NOW), null);
  assert.equal(daysUntil("soon", NOW), null);
  assert.equal(new Date(localDay("2026-11-01")).getDate(), 1, "local midnight, not UTC's (Oct 31 here)");
  assert.equal(dateLabel("2026-11-01", NOW), "Sun Nov 1");
  assert.equal(dateLabel("2027-01-02", NOW), "Sat Jan 2 2027");
  zone("Pacific/Auckland");
  assert.equal(dateLabel("2026-11-01", NOW), "Sun Nov 1", "the same date in every zone");
  assert.equal(daysUntil("2026-11-01", NOW), 0, "it's already Nov 1 in Auckland");
});

test("tzArg gives the offset now and at each midnight of the last 30 days", () => {
  zone("America/Los_Angeles");
  const now = Date.UTC(2026, 10, 10, 20, 0); // Nov 10, after DST ended on Nov 1
  const offs = tzArg(now).split(",").map(Number);
  assert.equal(offs.length, 32);
  assert.equal(offs[0], 480);
  // Midnights Oct 12 .. Nov 1 were daylight time, Nov 2 .. Nov 11 standard.
  assert.deepEqual(offs.slice(1), [...Array(21).fill(420), ...Array(10).fill(480)]);
});

test("velocity names days from their middle, with or without edges", () => {
  zone("America/Los_Angeles");
  // Mar 8 2026 is the spring DST change. Days Feb 21 .. Mar 22 (30), ending "today".
  const edges = Array.from({ length: 31 }, (_, i) => new Date(2026, 1, 21 + i).getTime());
  const v = { n: 30, size: DAY, start: edges[0], edges };
  assert.equal(bucketLabel(0, v), "Sat Feb 21");
  assert.equal(bucketLabel(15, v), "Sun Mar 8");
  assert.equal(edges[16] - edges[15], 23 * 3600000, "the change day is 23 hours");
  assert.equal(bucketLabel(16, v), "Mon Mar 9");
  assert.equal(rangeStart(v), "Feb 21");
  // An answer without edges: equal days from today's midnight (daylight time) put the
  // days before the change at 11 PM the evening before. Still named right.
  const today = edges[29];
  const old = { n: 30, size: DAY, start: today - 29 * DAY };
  assert.equal(new Date(old.start).getHours(), 23);
  assert.equal(bucketLabel(0, old), "Sat Feb 21");
  assert.equal(rangeStart(old), "Feb 21");
  assert.equal(bucketLabel(29, old), "Today");
});
