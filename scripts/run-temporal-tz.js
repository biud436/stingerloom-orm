#!/usr/bin/env node
/**
 * Replays the temporal suites under several process timezones.
 *
 * Every timezone defect this repo has hit — a zone-less wall-clock write, a
 * soft-delete stamp decoded in the wrong zone, a DATE column shifting a
 * calendar day — is invisible when the tests run in UTC, which is what CI and
 * most containers use. Assigning `process.env.TZ` inside a Jest test does not
 * reach V8's timezone cache, so the zone has to be set per process: this
 * script runs Jest once per zone.
 *
 * Usage: pnpm test:temporal-tz [extra jest args]
 */
const { spawnSync } = require("node:child_process");

/** Positive, zero and negative UTC offsets, plus a half-hour offset. */
const TIMEZONES = ["UTC", "Asia/Seoul", "America/New_York", "Asia/Kolkata"];

const PATTERN =
  "(integration/sqlite/(temporal|soft-delete|cursor-pagination|getcursor)|unit/(temporal|timestamptz|create-update-timestamp))";

const extraArgs = process.argv.slice(2);
const failures = [];

for (const tz of TIMEZONES) {
  process.stdout.write(`\n=== TZ=${tz} ===\n`);
  const result = spawnSync(
    "npx",
    ["jest", `--testPathPattern=${PATTERN}`, "--no-coverage", ...extraArgs],
    {
      stdio: "inherit",
      env: { ...process.env, TZ: tz, INTEGRATION_TEST: "true" },
      shell: process.platform === "win32",
    },
  );
  if (result.status !== 0) failures.push(tz);
}

if (failures.length > 0) {
  process.stdout.write(`\nTemporal timezone matrix failed in: ${failures.join(", ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`\nTemporal timezone matrix passed in all ${TIMEZONES.length} zones.\n`);
}
