// Tiny check runner: assertions that count, a summary, and exit codes the run-all script understands.
//   exit 0 = passed, 1 = failed, 3 = skipped (prerequisite missing)
import assert from 'node:assert/strict';

export const EXIT = { PASS: 0, FAIL: 1, SKIP: 3 };

export function skip(reason) {
  console.log(`SKIP  ${reason}`);
  process.exit(EXIT.SKIP);
}

export function createCheck(title) {
  let passed = 0;
  const failures = [];
  console.log(`\n▶ ${title}`);
  return {
    /** Assert a condition; failures are collected, not thrown, so one run reports everything. */
    ok(cond, message) {
      if (cond) { passed++; return true; }
      failures.push(message);
      console.log(`  ✗ ${message}`);
      return false;
    },
    eq(actual, expected, message) {
      try { assert.deepEqual(actual, expected); passed++; return true; }
      catch { failures.push(message); console.log(`  ✗ ${message}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`); return false; }
    },
    info: (msg) => console.log(`  · ${msg}`),
    finish() {
      if (failures.length) { console.log(`✗ FAILED — ${failures.length} failure(s), ${passed} passed`); process.exit(EXIT.FAIL); }
      console.log(`✓ PASSED — ${passed} assertion(s)`);
      process.exit(EXIT.PASS);
    },
  };
}
