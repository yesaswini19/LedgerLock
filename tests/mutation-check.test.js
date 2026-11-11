'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyResult,
  formatChildDiagnostics,
  getInfrastructureFailure,
  isLoopbackServerAddress,
} = require('../scripts/mutation-check');

const expectedTestName = 'NO DEADLOCK: opposite-direction transfers racing';
const expectedMarker = 'MUTATION_CHECK:ROW_LOCK: opposite transfers all complete';
const mutant = {
  expectedAssertions: [[expectedTestName, expectedMarker]],
};

function tapFailure({ name = expectedTestName, assertionName, code, message }) {
  return {
    status: 1,
    stdout: [
      'TAP version 13',
      `not ok 1 - ${name}`,
      '  ---',
      `  name: '${assertionName}'`,
      `  code: '${code}'`,
      `  error: '${message}'`,
      '  ...',
      '# tests 1',
      '# pass 0',
      '# fail 1',
      '1..1',
    ].join('\n'),
    stderr: '',
  };
}

test('mutation preflight accepts IPv6 loopback with PostgreSQL CIDR suffix', () => {
  assert.equal(isLoopbackServerAddress('::1/128'), true);
});

test('mutation preflight accepts IPv6 loopback without CIDR suffix', () => {
  assert.equal(isLoopbackServerAddress('::1'), true);
});

test('mutation preflight accepts IPv4 loopback addresses only in 127/8', () => {
  assert.equal(isLoopbackServerAddress('127.0.0.1'), true);
  assert.equal(isLoopbackServerAddress('127.42.9.3/32'), true);
});

test('mutation preflight accepts IPv4-mapped IPv6 loopback only when mapped to 127/8', () => {
  assert.equal(isLoopbackServerAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackServerAddress('::ffff:127.42.9.3/128'), true);
  assert.equal(isLoopbackServerAddress('::ffff:192.168.1.1'), false);
});

test('mutation preflight rejects non-loopback, malformed, and invalid CIDR addresses', () => {
  for (const address of [
    '10.0.0.1',
    '169.254.1.1',
    '192.168.1.1',
    '8.8.8.8',
    '2001:4860:4860::8888',
    'fe80::1',
    '::2',
    '127.0.0.1/33',
    '::1/129',
    '::1/not-a-prefix',
    '::1/128/1',
    'not-an-ip',
    null,
  ]) {
    assert.equal(isLoopbackServerAddress(address), false, String(address));
  }
});

test('transaction SQLSTATE is not automatically classified as an infrastructure error', () => {
  const output = "not ok 1 - target\n  code: '40P01'\n  error: 'deadlock detected'";
  assert.equal(getInfrastructureFailure(output), null);
  assert.equal(classifyResult(mutant, tapFailure({
    assertionName: 'Error',
    code: '40P01',
    message: 'deadlock detected',
  })).status, 'INCONCLUSIVE');
});

test('connection SQLSTATE is classified as an infrastructure error', () => {
  const result = tapFailure({
    assertionName: 'Error',
    code: '08006',
    message: 'connection failure',
  });
  assert.equal(getInfrastructureFailure(result.stdout), 'database connection SQLSTATE');
  assert.equal(classifyResult(mutant, result).status, 'ERROR');
});

test('designated assertion failure counts as a killed mutant', () => {
  const result = tapFailure({
    assertionName: 'AssertionError',
    code: 'ERR_ASSERTION',
    message: `expected true; ${expectedMarker}`,
  });
  assert.equal(classifyResult(mutant, result).status, 'KILLED');
});

test('unrelated assertion failure is inconclusive', () => {
  const result = tapFailure({
    assertionName: 'AssertionError',
    code: 'ERR_ASSERTION',
    message: 'unrelated assertion failed',
  });
  assert.equal(classifyResult(mutant, result).status, 'INCONCLUSIVE');
});

test('child diagnostics redact URLs and sensitive key-value fields', () => {
  const diagnostics = formatChildDiagnostics({
    stdout: 'connection postgresql://sample:do-not-print@localhost/db failed',
    stderr: 'password=do-not-print token:do-not-print',
  });
  assert.doesNotMatch(diagnostics, /do-not-print|postgresql:\/\//);
  assert.match(diagnostics, /\[redacted database URL\]/);
  assert.match(diagnostics, /\[redacted\]/);
});
