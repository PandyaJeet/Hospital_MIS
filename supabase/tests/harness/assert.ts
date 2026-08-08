/**
 * Minimal shared assertion + reporting helpers for the backend test scripts.
 *
 * Deliberately not Vitest: rules.md nominates Vitest for unit tests in apps/web,
 * but these are standalone DB integration scripts run through tsx (the prompt
 * sanctions "a small TypeScript script"), and the local suite has to boot PGlite
 * before anything can be asserted. Keeping this dependency-free means the backend
 * track adds no test-runner surface of its own.
 */

let passed = 0;
let failed = 0;
const failures: string[] = [];

export function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    failures.push(label + (detail ? ` — ${detail}` : ''));
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

export function checkEqual(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(label, a === e, a === e ? undefined : `expected ${e}, got ${a}`);
}

/** Asserts a call is rejected, optionally with a specific SQLSTATE/error code. */
export async function checkRejects(
  label: string,
  fn: () => Promise<unknown>,
  expectedCode?: string,
): Promise<void> {
  try {
    await fn();
    check(label, false, 'expected rejection, but the call succeeded');
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (expectedCode) {
      check(label, code === expectedCode, code === expectedCode ? undefined : `expected code ${expectedCode}, got ${code}`);
    } else {
      check(label, true);
    }
  }
}

export function section(title: string): void {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
}

export function summary(suiteName: string): never {
  console.log(`\n${'='.repeat(64)}`);
  console.log(`${suiteName}: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log('='.repeat(64));
  process.exit(failed > 0 ? 1 : 0);
}
