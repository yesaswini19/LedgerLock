'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { Client } = require('pg');
const net = require('net');
require('dotenv').config();

const DEFAULT_TEST_TIMEOUT_MS = 120000;
const MAX_TEST_TIMEOUT_MS = 2147483647;
const file = path.join(__dirname, '../src/ledger.js');

function isLoopbackServerAddress(address) {
  if (typeof address !== 'string') return false;

  const slash = address.indexOf('/');
  const ip = slash === -1 ? address : address.slice(0, slash);
  if (slash !== -1 && (slash !== address.lastIndexOf('/') ||
      !/^(0|[1-9]\d*)$/.test(address.slice(slash + 1)))) {
    return false;
  }

  const family = net.isIP(ip);
  if (!family) return false;
  if (slash !== -1) {
    const prefix = Number(address.slice(slash + 1));
    if (prefix > (family === 4 ? 32 : 128)) return false;
  }

  if (family === 4) return Number(ip.split('.')[0]) === 127;

  const dottedIpv4 = ip.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/);
  let ipv6 = ip.toLowerCase();
  if (dottedIpv4) {
    const octets = dottedIpv4[1].split('.').map(Number);
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    ipv6 = ipv6.replace(dottedIpv4[1], `${high}:${low}`);
  }

  const halves = ipv6.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : left;
  if (halves.length > 2 || groups.length !== 8) return false;

  const value = groups.reduce((result, group) => (result << 16n) | BigInt(`0x${group || '0'}`), 0n);
  if (value === 1n) return true;

  const isIpv4Mapped = (value >> 32n) === 0xffffn;
  const mappedIpv4 = Number(value & 0xffffffffn);
  return isIpv4Mapped && (mappedIpv4 >>> 24) === 127;
}

const MUTANTS = [
  {
    name: 'remove row lock (FOR UPDATE)',
    find: 'ORDER BY id FOR UPDATE',
    replace: 'ORDER BY id',
    expectedAssertions: [
      ['CONSERVATION: random concurrent transfers never change the total; ledger balances', 'MUTATION_CHECK:ROW_LOCK: transfer statuses are valid'],
      ['CONSERVATION: random concurrent transfers never change the total; ledger balances', 'MUTATION_CHECK:ROW_LOCK: customer balances are conserved'],
      ['CONSERVATION: random concurrent transfers never change the total; ledger balances', 'MUTATION_CHECK:ROW_LOCK: global sum is conserved'],
      ['NO DOUBLE-SPEND: 20 concurrent withdrawals against a balance that covers 5', 'MUTATION_CHECK:WITHDRAWALS: exactly five succeed'],
      ['NO DOUBLE-SPEND: 20 concurrent withdrawals against a balance that covers 5', 'MUTATION_CHECK:WITHDRAWALS: exactly fifteen are refused'],
      ['NO DOUBLE-SPEND via transfers: 20 concurrent transfers out of one account', 'MUTATION_CHECK:TRANSFERS: exactly three succeed'],
      ['NO DOUBLE-SPEND via transfers: 20 concurrent transfers out of one account', 'MUTATION_CHECK:TRANSFERS: exactly seventeen are refused'],
      ['NO DEADLOCK: opposite-direction transfers racing', 'MUTATION_CHECK:ROW_LOCK: opposite transfers all complete'],
      ['NO DEADLOCK: opposite-direction transfers racing', 'MUTATION_CHECK:ROW_LOCK: opposite transfer balances are conserved'],
    ],
  },
  {
    name: 'remove insufficient-funds check',
    find: 'from.balance < amount',
    replace: 'false',
    testNames: [
      'setup',
      'NO DOUBLE-SPEND: 20 concurrent withdrawals against a balance that covers 5',
      'NO DOUBLE-SPEND via transfers: 20 concurrent transfers out of one account',
    ],
    expectedAssertions: [
      ['NO DOUBLE-SPEND: 20 concurrent withdrawals against a balance that covers 5', 'MUTATION_CHECK:WITHDRAWALS: exactly five succeed'],
      ['NO DOUBLE-SPEND: 20 concurrent withdrawals against a balance that covers 5', 'MUTATION_CHECK:WITHDRAWALS: exactly fifteen are refused'],
      ['NO DOUBLE-SPEND: 20 concurrent withdrawals against a balance that covers 5', 'MUTATION_CHECK:WITHDRAWALS: source balance is zero'],
      ['NO DOUBLE-SPEND via transfers: 20 concurrent transfers out of one account', 'MUTATION_CHECK:TRANSFERS: exactly three succeed'],
      ['NO DOUBLE-SPEND via transfers: 20 concurrent transfers out of one account', 'MUTATION_CHECK:TRANSFERS: exactly seventeen are refused'],
      ['NO DOUBLE-SPEND via transfers: 20 concurrent transfers out of one account', 'MUTATION_CHECK:TRANSFERS: source balance is zero'],
      ['NO DOUBLE-SPEND via transfers: 20 concurrent transfers out of one account', 'MUTATION_CHECK:TRANSFERS: destination balance is conserved'],
    ],
  },
  {
    name: 'remove ownership check',
    find: 'from.owner_id !== user.id',
    replace: 'false',
    expectedAssertions: [
      ["AUTHORISATION: a user cannot move another user's money", 'MUTATION_CHECK:OWNERSHIP: cross-owner transfer is rejected'],
      ["AUTHORISATION: a user cannot move another user's money", 'MUTATION_CHECK:OWNERSHIP: transfer rejection is ownership-based'],
      ["AUTHORISATION: a user cannot move another user's money", 'MUTATION_CHECK:OWNERSHIP: cross-owner withdrawal is rejected'],
    ],
  },
  {
    name: 'remove idempotency replay branch',
    find: 'if (ins.rowCount === 0) {',
    replace: 'if (false) {',
    expectedAssertions: [
      ['IDEMPOTENCY: replaying a key (sequential) moves money once and returns the same answer', 'MUTATION_CHECK:IDEMPOTENCY: sequential replay succeeds'],
      ['IDEMPOTENCY: replaying a key (sequential) moves money once and returns the same answer', 'MUTATION_CHECK:IDEMPOTENCY: sequential replay posts one transaction'],
      ['IDEMPOTENCY: 10 identical requests fired at once (retry while first in flight) pay once', 'MUTATION_CHECK:IDEMPOTENCY: concurrent replays succeed'],
      ['IDEMPOTENCY: 10 identical requests fired at once (retry while first in flight) pay once', 'MUTATION_CHECK:IDEMPOTENCY: concurrent requests share one transaction'],
      ['IDEMPOTENCY: 10 identical requests fired at once (retry while first in flight) pay once', 'MUTATION_CHECK:IDEMPOTENCY: one request claims the key'],
      ['IDEMPOTENCY: 10 identical requests fired at once (retry while first in flight) pay once', 'MUTATION_CHECK:IDEMPOTENCY: concurrent replay moves money once'],
      ['IDEMPOTENCY: same key, different body is rejected (422) and moves nothing', 'MUTATION_CHECK:IDEMPOTENCY: changed request is rejected'],
      ['IDEMPOTENCY: same key, different body is rejected (422) and moves nothing', 'MUTATION_CHECK:IDEMPOTENCY: changed request gets the key-reused error'],
    ],
  },
  {
    name: 'remove role check',
    find: 'if (user.role !== ROLE_FOR[type])',
    replace: 'if (false)',
    expectedAssertions: [
      ['AUTHORISATION: roles - holder cannot deposit, auditor cannot move money, admin cannot spend holder money', 'MUTATION_CHECK:ROLE: holder cannot deposit'],
      ['AUTHORISATION: roles - holder cannot deposit, auditor cannot move money, admin cannot spend holder money', 'MUTATION_CHECK:ROLE: auditor cannot deposit'],
    ],
  },
];

function getTestTimeoutMs() {
  const configured = process.env.MUTATION_TEST_TIMEOUT_MS;
  if (configured === undefined || configured === '') return DEFAULT_TEST_TIMEOUT_MS;
  const timeoutMs = Number(configured);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TEST_TIMEOUT_MS) {
    throw new Error(`MUTATION_TEST_TIMEOUT_MS must be an integer from 1 to ${MAX_TEST_TIMEOUT_MS}.`);
  }
  return timeoutMs;
}

function getTestDatabaseUrl() {
  const value = process.env.TEST_DATABASE_URL;
  if (!value || !value.trim()) {
    throw new Error('TEST_DATABASE_URL is required; refusing to run mutation-check.');
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('TEST_DATABASE_URL must be a valid PostgreSQL URL for local ledgerline_test.');
  }

  const localHosts = ['localhost', '127.0.0.1', '::1', '[::1]'];
  const hostOverrides = url.searchParams.getAll('host');
  const hasRemoteHostOverride = hostOverrides.some((host) => !localHosts.includes(host.toLowerCase())) ||
    url.searchParams.has('hostaddr');
  let databaseName;
  try {
    databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  } catch {
    throw new Error('TEST_DATABASE_URL must identify local PostgreSQL database ledgerline_test.');
  }

  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      !localHosts.includes(url.hostname.toLowerCase()) ||
      hasRemoteHostOverride ||
      databaseName !== 'ledgerline_test') {
    throw new Error('TEST_DATABASE_URL must target local PostgreSQL database ledgerline_test; refusing to run mutation-check.');
  }
  return value;
}

async function verifyDatabase(url) {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    const result = await client.query('SELECT current_database() AS database_name, inet_server_addr()::text AS server_address');
    const address = result.rows[0]?.server_address;
    if (result.rows[0]?.database_name !== 'ledgerline_test' || !isLoopbackServerAddress(address)) {
      throw new Error('Connected server/database did not match local ledgerline_test.');
    }
  } catch {
    throw new Error('Could not verify local ledgerline_test; source file was not modified.');
  } finally {
    await client.end().catch(() => {});
  }
}

function getInfrastructureFailure(output) {
  const checks = [
    ['missing test database configuration', /TEST_DATABASE_URL is required|TEST_DATABASE_URL must/i],
    ['child test timeout or output-buffer failure', /ETIMEDOUT|ENOBUFS|timed out|timeout|stdout maxBuffer|stderr maxBuffer/i],
    ['database connection failure', /ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|connection (?:terminated|refused|timeout)|connection to .* failed|could not connect to server|server closed the connection/i],
    ['database authentication/configuration failure', /password authentication failed|no pg_hba\.conf entry|database "[^"]+" does not exist|role "[^"]+" does not exist|certificate verify failed|self[- ]signed certificate|\b(?:28P01|28000|3D000)\b/i],
    ['database shutdown or recovery', /\b57P0[123]\b|database system is (?:shutting down|in recovery)|the database system is starting up/i],
    ['database schema/privilege failure', /relation "[^"]+" does not exist|schema "[^"]+" does not exist|permission denied|must be owner of (?:table|relation)|trigger "[^"]+" does not exist/i],
    ['database connection SQLSTATE', /\b(?:code|sqlstate):? ['"]?08[0-9A-Z]{3}['"]?|\b08[0-9A-Z]{3}\b/i],
    ['test runner or module failure', /ERR_TEST_FAILURE|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find module|Could not find ['"]tests\/ledger\.test\.js/i],
  ];
  return checks.find(([, pattern]) => pattern.test(output))?.[0] || null;
}

function sanitizeDiagnostic(value) {
  return String(value || '')
    .replace(/postgres(?:ql)?:\/\/[^\s"'`]+/gi, '[redacted database URL]')
    .replace(/\b(password|passwd|pwd|token|secret|authorization|api[_-]?key)\b(\s*[:=]\s*|\s+)([^,\s;]+)/gi, '$1$2[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]');
}

function formatChildDiagnostics(result) {
  const sections = [];
  for (const [label, value] of [['stdout', result.stdout], ['stderr', result.stderr]]) {
    if (!value) continue;
    const text = sanitizeDiagnostic(value);
    const limit = 4000;
    sections.push(`${label}:\n${text.length > limit ? `${text.slice(0, limit)}\n[truncated]` : text}`);
  }
  if (result.error) {
    sections.push(`spawn error: ${sanitizeDiagnostic(result.error.message)}`);
  }
  return sections.length ? `\nChild diagnostics (sanitized):\n${sections.join('\n')}` : '\nChild diagnostics: no output captured.';
}

function parseTap(output) {
  const results = [];
  let current = null;
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(not ok|ok) \d+ - (.+)$/);
    if (match) {
      if (current) results.push(current);
      const skipped = match[1] === 'ok' && /\s+# SKIP(?:\s|$)/.test(match[2]);
      const name = match[2].replace(/\s+# SKIP(?:\s.*)?$/, '').trim();
      current = { failed: match[1] === 'not ok', skipped, name, output: line };
    } else if (current) {
      if (/^# Subtest:/.test(line)) {
        results.push(current);
        current = null;
      } else {
        current.output += `\n${line}`;
      }
    }
  }
  if (current) results.push(current);

  const number = (name) => {
    const match = output.match(new RegExp(`^# ${name} (\\d+)\\s*$`, 'm'));
    return match ? Number(match[1]) : null;
  };
  return {
    results,
    tests: number('tests'),
    passed: number('pass'),
    failed: number('fail'),
    cancelled: number('cancelled') ?? 0,
    skipped: number('skipped') ?? 0,
    hasPlan: /^1\.\.\d+\s*$/m.test(output),
  };
}

function classifyResult(mutant, result) {
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') {
      return { status: 'ERROR', reason: 'child test process timed out' };
    }
    if (result.error.code === 'ENOBUFS') {
      return { status: 'ERROR', reason: 'child test output exceeded the configured buffer' };
    }
    return { status: 'ERROR', reason: `could not start tests: ${result.error.message}` };
  }
  if (result.signal) {
    return { status: 'ERROR', reason: `test process was interrupted (${result.signal})` };
  }
  if (result.status === null || (result.status !== 0 && result.status !== 1)) {
    return { status: 'ERROR', reason: `test process exited unexpectedly with status ${result.status}` };
  }

  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const infrastructureFailure = getInfrastructureFailure(output);
  if (infrastructureFailure) {
    return { status: 'ERROR', reason: infrastructureFailure };
  }

  const tap = parseTap(output);
  if (!tap.hasPlan || tap.tests === null || tap.passed === null || tap.failed === null ||
      tap.cancelled !== 0 ||
      (tap.skipped > 0 && !mutant.testNames) ||
      tap.tests !== tap.passed + tap.failed + tap.skipped ||
      tap.tests !== tap.results.length ||
      tap.failed !== tap.results.filter((item) => item.failed).length ||
      tap.skipped !== tap.results.filter((item) => item.skipped).length) {
    return { status: 'INCONCLUSIVE', reason: 'test output was incomplete or did not contain a consistent TAP summary' };
  }

  if (mutant.testNames) {
    const missingTests = mutant.testNames.filter((name) =>
      !tap.results.some((item) => item.name === name && !item.skipped));
    if (missingTests.length) {
      return { status: 'INCONCLUSIVE', reason: `selected tests did not run: ${missingTests.join(', ')}` };
    }
  }

  if (result.status === 0) {
    return tap.failed === 0
      ? { status: 'SURVIVED' }
      : { status: 'INCONCLUSIVE', reason: 'test output reported failures despite a successful process exit' };
  }

  if (tap.failed === 0) {
    return { status: 'INCONCLUSIVE', reason: 'test process failed without a reported failing test' };
  }

  const failures = tap.results.filter((item) => item.failed);
  const unexpected = failures.filter((item) =>
    !mutant.expectedAssertions.some(([testName]) => item.name === testName));
  if (unexpected.length) {
    return { status: 'INCONCLUSIVE', reason: `unrelated test failure: ${unexpected.map((item) => item.name).join(', ')}` };
  }

  const unattributed = failures.filter((item) =>
    !/name: ['"]AssertionError['"]/.test(item.output) ||
    !/code: ['"]ERR_ASSERTION['"]/.test(item.output) ||
    !mutant.expectedAssertions.some(([testName, assertionMarker]) =>
      item.name === testName && item.output.includes(assertionMarker)));
  if (unattributed.length) {
    return { status: 'INCONCLUSIVE', reason: `failure did not match a designated assertion: ${unattributed.map((item) => item.name).join(', ')}` };
  }

  return { status: 'KILLED' };
}

async function main() {
  const testTimeoutMs = getTestTimeoutMs();
  const testDatabaseUrl = getTestDatabaseUrl();
  await verifyDatabase(testDatabaseUrl);

  const originalBytes = fs.readFileSync(file);
  const original = originalBytes.toString('utf8');
  for (const mutant of MUTANTS) {
    if (!original.includes(mutant.find)) {
      throw new Error(`Cannot apply mutant "${mutant.name}": expected source pattern was not found; source file was not modified.`);
    }
  }

  const childEnv = {
    ...process.env,
    TEST_DATABASE_URL: testDatabaseUrl,
    DATABASE_URL: testDatabaseUrl,
  };
  let sourceMutated = false;
  let interruptedSignal = null;
  let restorationError = null;
  const restore = () => {
    if (sourceMutated) {
      try {
        fs.writeFileSync(file, originalBytes);
        sourceMutated = false;
      } catch (error) {
        restorationError = error;
        throw new Error(`Failed to restore original src/ledger.js; mutation-check must abort: ${error.message}`);
      }
    }
  };
  const onSignal = (signal) => {
    interruptedSignal = signal;
    try {
      restore();
    } catch (error) {
      restorationError = error;
    }
  };

  try {
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    for (const mutant of MUTANTS) {
      let result;
      sourceMutated = true;
      try {
        fs.writeFileSync(file, original.replace(mutant.find, mutant.replace), 'utf8');
        const testArgs = ['--test'];
        if (mutant.testNames) {
          const escapePattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          testArgs.push('--test-name-pattern', `^(?:${mutant.testNames.map(escapePattern).join('|')})$`);
        }
        testArgs.push('tests/ledger.test.js');
        result = spawnSync('node', testArgs, {
          encoding: 'utf8',
          env: childEnv,
          maxBuffer: 10 * 1024 * 1024,
          timeout: testTimeoutMs,
          killSignal: 'SIGTERM',
        });
      } finally {
        restore();
      }

      if (interruptedSignal) {
        throw new Error(`Mutation-check was interrupted (${interruptedSignal})${restorationError ? '; source restoration failed' : ''}.`);
      }

      const classification = classifyResult(mutant, result);
      if (classification.status === 'ERROR' || classification.status === 'INCONCLUSIVE') {
        throw new Error(`${classification.status}: "${mutant.name}" ${classification.reason}. Aborting mutation-check.${formatChildDiagnostics(result)}`);
      }
      console.log(`${classification.status.padEnd(8)} ${mutant.name}`);
    }
  } finally {
    try {
      restore();
    } finally {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }
  }

  console.log('\nAll mutants were classified from their targeted assertion tests.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Mutation check aborted: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  classifyResult,
  formatChildDiagnostics,
  getInfrastructureFailure,
  isLoopbackServerAddress,
};
