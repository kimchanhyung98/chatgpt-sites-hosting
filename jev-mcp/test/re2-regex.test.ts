import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RE2JS } from 're2js';
import {
  createRegexRunner,
  estimateProgramSize,
  MAX_REGEX_PROGRAM_SIZE,
  REGEX_WORK_BUDGET,
} from '../src/infrastructure/re2-regex.js';

const clean = (candidates: string[], truncated = false, tooLong = 0) => ({
  candidates, truncated, tooLong, error: null,
});

test('raw whole matches retain whitespace, order and Unicode while deduplicating', async () => {
  const run = createRegexRunner();
  assert.deepEqual(await run('10\t 10\t 20\t', '(\\d+)\\t', 'g'), clean(['10\t', '20\t']));
  assert.deepEqual(await run('😀x😀', '.', 'g'), clean(['😀', 'x']));
});

test('candidate cap applies after deduplication and overlong filtering', async () => {
  const twenty = Array.from({ length: 20 }, (_, i) => String(i));
  assert.deepEqual(await createRegexRunner()(twenty.join(' ') + ' 0', '\\d+', 'g'), clean(twenty));
  assert.deepEqual(await createRegexRunner()([...twenty, '20'].join(' '), '\\d+', 'g'), clean(twenty, true));
  const text = ['X'.repeat(2001), 'X'.repeat(2001), ...twenty].join(' ');
  assert.deepEqual(await createRegexRunner()(text, '\\w+', 'g'), clean(twenty, false, 1));
});

test('candidate length uses UTF-16 units and rejects rather than truncates', async () => {
  const text = '😀'.repeat(1000);
  assert.deepEqual(await createRegexRunner()(text, '.+', 'g'), clean([text]));
  assert.deepEqual(await createRegexRunner()(text + '😀', '.+', 'g'), clean([], false, 1));
});

test('empty matches advance and do not enter the candidate set', async () => {
  assert.deepEqual(await createRegexRunner()('aa', 'a*', 'g'), clean(['aa']));
  assert.deepEqual(await createRegexRunner()('😀😀', 'a*', 'g'), clean([]));
});

test('supported flags map to RE2, with Unicode always enabled and global iteration', async () => {
  assert.deepEqual(await createRegexRunner()('USD usd', 'usd', 'ig'), clean(['USD', 'usd']));
  assert.deepEqual(await createRegexRunner()('x\na\nx', '^a$', 'm'), clean(['a']));
  assert.deepEqual(await createRegexRunner()('a\nb', 'a.b', 's'), clean(['a\nb']));
  assert.deepEqual(await createRegexRunner()('😀a', '.', 'u'), clean(['😀', 'a']));
  assert.deepEqual(await createRegexRunner()('a a', 'a', 'gg'), clean(['a']));
  for (const flags of ['ii', 'mm', 'uu', 'd', 'y', 'v', 'a', 'g!']) {
    const result = await createRegexRunner()('a', 'a', flags);
    assert.ok(result.error, flags);
    assert.deepEqual(result.candidates, []);
  }
});

test('unsupported lookaround and backreferences are rejected without native RegExp execution', async () => {
  for (const pattern of ['a(?=b)', 'a(?!b)', '(?<=a)b', '(?<!a)b', '(a)\\1', '(?<a>a)\\k<a>']) {
    const result = await createRegexRunner()('ab', pattern, 'g');
    assert.ok(result.error, pattern);
    assert.deepEqual(result.candidates, []);
  }
});

test('RE2 dialect is deliberate: Unicode code points and end-of-input anchor semantics', async () => {
  assert.deepEqual(await createRegexRunner()('😀', '.', 'g'), clean(['😀']));
  assert.deepEqual(await createRegexRunner()('a\n', 'a$', 'g'), clean([]));
  assert.deepEqual(await createRegexRunner()('αβγ', '\\p{Greek}+', 'g'), clean(['αβγ']));
});

test('bounded catastrophic backtracking examples complete without timeout promises', async () => {
  for (const pattern of ['^(a+)+$', '^(a|aa)+$', '(a+)+b']) {
    assert.deepEqual(await createRegexRunner()('a'.repeat(49_999) + '!', pattern, 'g'), clean([]));
  }
});

test('global matching also consumes the budget, preventing quadratic duplicate scans', async () => {
  const result = await createRegexRunner()('a'.repeat(50_000), '.*b|a', 'g');
  assert.deepEqual(result, clean(['a'], true));
});

test('budget exhaustion preserves eligible candidates and skipped-match counts', async () => {
  const run = createRegexRunner();
  const result = await run('X'.repeat(2001) + ' 123 '.repeat(9500), '\\w+', 'g');
  assert.deepEqual(result, clean(['123'], true, 1));
  assert.match((await run('a'.repeat(50_000), '\\w+', 'g')).error ?? '', /work budget/);
});

test('budget exhaustion after empty matches is incomplete rather than absent', async () => {
  assert.deepEqual(await createRegexRunner()('a'.repeat(50_000), 'z*', 'g'), clean([], true));
});

test('bounded but expensive searches are refused before matching', async () => {
  const result = await createRegexRunner()('a'.repeat(50_000), '.{0,1000}$', 'g');
  assert.match(result.error ?? '', /work budget/);
  assert.deepEqual(result.candidates, []);
});

test('work budget spans all fields in one runner and resets only for a new request runner', async () => {
  const document = 'a'.repeat(50_000);
  const pattern = '^Z$';
  const size = RE2JS.compile(pattern).programSize();
  const charge = size * (document.length + 1) + Math.ceil(size * (document.length + 1) / 32);
  const permitted = Math.floor(REGEX_WORK_BUDGET / charge);
  assert.ok(permitted > 0 && permitted < 32);
  const run = createRegexRunner();
  for (let i = 0; i < permitted; i += 1) assert.deepEqual(await run(document, pattern, 'g'), clean([]));
  assert.match((await run(document, pattern, 'g')).error ?? '', /work budget/);
  assert.deepEqual(await createRegexRunner()(document, pattern, 'g'), clean([]));
});

test('precompile limits reject short source with enormous repeated groups', async () => {
  const patterns = [
    `(?:${'a'.repeat(480)}){1000}`,
    `(?:a{${'0'.repeat(480)}}){1000}`,
    '(?:a{00}){1000}',
    '(?:a{0,00}){1000}',
    '(a{1000}){1000}',
  ];
  for (const pattern of patterns) {
    assert.ok(pattern.length <= 500);
    assert.throws(() => estimateProgramSize(pattern), /estimated program|repeat count/);
    const result = await createRegexRunner()('a', pattern, 'g');
    assert.match(result.error ?? '', /estimated program|repeat count/);
  }
});

test('cost scanner preserves common datetime, UUID and email patterns', async () => {
  const cases = [
    ['date: 2026-10-02T12:30:00', '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}', '2026-10-02T12:30:00'],
    ['id: 123e4567-e89b-12d3-a456-426614174000', '[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}', '123e4567-e89b-12d3-a456-426614174000'],
    ['mail: sample@example.com', '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}', 'sample@example.com'],
  ];
  for (const [document, pattern, expected] of cases) {
    assert.ok(estimateProgramSize(pattern!) <= MAX_REGEX_PROGRAM_SIZE);
    assert.deepEqual(await createRegexRunner()(document!, pattern!, 'g'), clean([expected!]));
  }
});

test('cost scanner does not undercount supported escapes, groups and repetitions', () => {
  for (const pattern of [
    '(?:ab|cd){2,5}', '(?i:a|b){2,6}', '(?P<hello>[a-z]+)',
    '\\Q[hi]\\E{4}', '[]a]{2,10}', '[[:alpha:]]{1,5}', 'a|', '|b',
    '\\p{Greek}{2,5}', '\\x{1F600}{2}', '(?i)(a|B){2,3}', '(a(?i)){2,3}',
    '😀{2,5}', 'a{00}', 'a{0,00}', 'a{000,2}', '(?:abc){0}', '\\123{3}',
  ]) {
    assert.ok(estimateProgramSize(pattern) >= RE2JS.compile(pattern).programSize(), pattern);
  }
});

test('invalid patterns and size limits become empty field errors', async () => {
  for (const pattern of ['(', ')', '[abc', '[[:alpha]', '\\p{Greek', '(?<name', '(?=x)', 'a{1001}', 'a{5,2}', '*']) {
    const result = await createRegexRunner()('a', pattern, 'g');
    assert.ok(result.error, pattern);
    assert.deepEqual(result.candidates, []);
  }
  assert.match((await createRegexRunner()('a', '', 'g')).error ?? '', /pattern/);
  assert.match((await createRegexRunner()('a', 'a'.repeat(501), 'g')).error ?? '', /pattern/);
  assert.match((await createRegexRunner()('a'.repeat(50_001), 'a', 'g')).error ?? '', /document/);
});

test('an already cancelled request returns no candidates and does not consume the budget', async () => {
  const controller = new AbortController();
  controller.abort();
  const run = createRegexRunner();
  assert.deepEqual(await run('hello', '.+', 'g', controller.signal), { ...clean([]), error: 'request aborted' });
  assert.deepEqual(await run('hello', '.+', 'g'), clean(['hello']));
});
