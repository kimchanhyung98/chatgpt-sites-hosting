import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTypeSafeEvaluator, TypeSafeError } from '../src/infrastructure/typesafe.js';

const API_KEY = 'test-only-key-never-log-me';
const MODEL = 'jev-1.13.0';
const questions = { relevant: { type: 'noul' as const, instructions: 'Is `text` relevant?' } };
const state = { text: 'Example input' };
const validResult = {
  model: MODEL,
  answers: { relevant: { type: 'noul' as const, noul: 0.91 } },
  usage: { input_tokens: 42, output_tokens: 3 },
};

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
}

function expectedError(code: string, status?: number): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof TypeSafeError);
    assert.equal(error.code, code);
    assert.ok(error.message.length > 0);
    if (status !== undefined) assert.equal(error.status, status);
    assert.ok(!error.message.includes(API_KEY));
    return true;
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('posts one fixed-endpoint request and preserves model, answers, and token usage', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    calls += 1;
    assert.equal(String(input), 'https://api.typesafe.ai/v1/systemone');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'manual');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), `Bearer ${API_KEY}`);
    assert.equal(headers.get('content-type'), 'application/json');
    assert.deepEqual(JSON.parse(await new Response(init?.body).text()), { state, questions, model: MODEL });
    assert.ok(init?.signal instanceof AbortSignal);
    return jsonResponse(validResult);
  };
  const ask = createTypeSafeEvaluator({ apiKey: API_KEY, fetch: fetcher });
  assert.deepEqual(await ask(state, questions, MODEL), { ...validResult, provider: 'typesafe' });
  assert.equal(calls, 1);
});

test('preserves choice confidence separately from probability and fractional score', async () => {
  const requestQuestions = {
    label: { type: 'choice' as const, instructions: 'Choose a label.', criteria: { a: 'A', b: 'B' } },
    level: { type: 'score' as const, instructions: 'Rate the level.', criteria: ['Low', 'High'] },
    relevant: questions.relevant,
  };
  const response = {
    model: 'jev-upstream-resolved-version',
    answers: {
      label: { type: 'choice', choice: 'a', confidence: 0.6, probabilities: { a: 0.8, b: 0.2 } },
      level: {
        type: 'score', score: 0.75, confidence: 0.5,
        probabilities: { '0': 0.25, '1': 0.75 }, legend: { '0': 'Low', '1': 'High' },
      },
      relevant: { type: 'noul', noul: 0.91 },
    },
    usage: { input_tokens: 100, output_tokens: 10 },
  };
  const ask = createTypeSafeEvaluator({ apiKey: API_KEY, fetch: async () => jsonResponse(response) });
  assert.deepEqual(await ask(state, requestQuestions, MODEL), { ...response, provider: 'typesafe' });
});

for (const [name, response] of [
  ['missing question', { ...validResult, answers: {} }],
  ['extra question', { ...validResult, answers: { ...validResult.answers, extra: { type: 'noul', noul: 0.4 } } }],
  ['mismatched question type', { ...validResult, answers: { relevant: { type: 'score', score: 1 } } }],
  ['out-of-range probability', { ...validResult, answers: { relevant: { type: 'noul', noul: 1.01 } } }],
] as const) {
  test(`forwards raw answers for tool-level validation: ${name}`, async () => {
    const ask = createTypeSafeEvaluator({ apiKey: API_KEY, fetch: async () => jsonResponse(response) });
    assert.deepEqual(await ask(state, questions, MODEL), { ...response, provider: 'typesafe' });
  });
}

test('a malformed sibling answer does not discard a valid answer', async () => {
  const requestQuestions = { relevant: questions.relevant, second: questions.relevant };
  const response = {
    ...validResult,
    answers: { ...validResult.answers, second: { type: 'noul', noul: 'invalid-value' } },
  };
  const ask = createTypeSafeEvaluator({ apiKey: API_KEY, fetch: async () => jsonResponse(response) });
  assert.deepEqual(await ask(state, requestQuestions, MODEL), { ...response, provider: 'typesafe' });
});

for (const [name, response] of [
  ['missing model', { answers: validResult.answers, usage: validResult.usage }],
  ['missing answers map', { model: MODEL, usage: validResult.usage }],
  ['non-object answers map', { ...validResult, answers: [] }],
  ['negative token usage', { ...validResult, usage: { input_tokens: -1, output_tokens: 3 } }],
  ['fractional token usage', { ...validResult, usage: { input_tokens: 1.5, output_tokens: 3 } }],
  ['missing token usage', { model: MODEL, answers: validResult.answers }],
] as const) {
  test(`rejects an invalid provider envelope: ${name}`, async () => {
    const ask = createTypeSafeEvaluator({ apiKey: API_KEY, fetch: async () => jsonResponse(response) });
    await assert.rejects(ask(state, questions, MODEL), expectedError('TYPESAFE_INVALID_RESPONSE'));
  });
}

for (const [name, body, contentType] of [
  ['malformed JSON', '{"answers":', 'application/json'],
  ['HTML', '<html><body>Bad gateway</body></html>', 'text/html'],
  ['JSON null', 'null', 'application/json'],
  ['JSON array', '[]', 'application/json'],
  ['empty response', '', 'application/json'],
] as const) {
  test(`rejects ${name} as an invalid provider response`, async () => {
    const ask = createTypeSafeEvaluator({
      apiKey: API_KEY,
      fetch: async () => new Response(body, { headers: { 'content-type': contentType } }),
    });
    await assert.rejects(ask(state, questions, MODEL), expectedError('TYPESAFE_INVALID_RESPONSE'));
  });
}

test('a 429 makes exactly one upstream attempt and retains the status', async () => {
  let calls = 0;
  const ask = createTypeSafeEvaluator({
    apiKey: API_KEY,
    fetch: async () => {
      calls += 1;
      return jsonResponse({ error: 'Rate limited' }, { status: 429, headers: { 'retry-after': '0' } });
    },
  });
  await assert.rejects(ask(state, questions, MODEL), expectedError('TYPESAFE_HTTP_ERROR', 429));
  assert.equal(calls, 1);
});

test('redirect responses are rejected without a second upstream request', async () => {
  let calls = 0;
  const ask = createTypeSafeEvaluator({
    apiKey: API_KEY,
    fetch: async (_input, init) => {
      calls += 1;
      assert.equal(init?.redirect, 'manual');
      return new Response(null, { status: 302, headers: { location: 'https://untrusted.invalid' } });
    },
  });
  await assert.rejects(ask(state, questions, MODEL), expectedError('TYPESAFE_HTTP_ERROR', 302));
  assert.equal(calls, 1);
});

test('upstream error messages and echoed credentials never enter exposed errors', async () => {
  const marker = 'untrusted-upstream-response-marker';
  const ask = createTypeSafeEvaluator({
    apiKey: API_KEY,
    fetch: async () => jsonResponse({ error: `${marker}: ${API_KEY}` }, { status: 401 }),
  });
  await assert.rejects(ask(state, questions, MODEL), (error: unknown) => {
    expectedError('TYPESAFE_HTTP_ERROR', 401)(error);
    assert.ok(error instanceof Error);
    const exposed = `${String(error)}\n${error.stack}\n${JSON.stringify(error)}`;
    assert.ok(!exposed.includes(API_KEY));
    assert.ok(!exposed.includes(marker));
    return true;
  });
});

test('network failures are classified without leaking fetch exception details', async () => {
  const ask = createTypeSafeEvaluator({
    apiKey: API_KEY,
    fetch: async () => { throw new Error(`network saw ${API_KEY}`); },
  });
  await assert.rejects(ask(state, questions, MODEL), (error: unknown) => {
    expectedError('TYPESAFE_NETWORK_ERROR')(error);
    assert.ok(error instanceof Error);
    assert.ok(!`${error.stack}\n${JSON.stringify(error)}`.includes(API_KEY));
    return true;
  });
});

test('an already aborted caller signal prevents the upstream request', async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort(new Error('private caller abort reason'));
  const ask = createTypeSafeEvaluator({
    apiKey: API_KEY,
    fetch: async () => { calls += 1; return jsonResponse(validResult); },
  });
  await assert.rejects(ask(state, questions, MODEL, controller.signal), expectedError('TYPESAFE_ABORTED'));
  assert.equal(calls, 0);
});

test('caller abort during fetch aborts the actual upstream signal', { timeout: 1500 }, async () => {
  const started = deferred<void>();
  const controller = new AbortController();
  let upstreamSignal: AbortSignal | null | undefined;
  const fetcher: typeof fetch = async (_input, init) => {
    upstreamSignal = init?.signal;
    assert.ok(upstreamSignal);
    const response = new Promise<Response>((_resolve, reject) => {
      upstreamSignal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
    started.resolve();
    return response;
  };
  const ask = createTypeSafeEvaluator({ apiKey: API_KEY, fetch: fetcher, timeoutMs: 1000 });
  const pending = ask(state, questions, MODEL, controller.signal);
  await started.promise;
  controller.abort();
  await assert.rejects(pending, expectedError('TYPESAFE_ABORTED'));
  assert.equal(upstreamSignal?.aborted, true);
});

test('timeout during fetch aborts the actual upstream signal', { timeout: 1500 }, async () => {
  let upstreamSignal: AbortSignal | null | undefined;
  const fetcher: typeof fetch = async (_input, init) => {
    upstreamSignal = init?.signal;
    assert.ok(upstreamSignal);
    return new Promise<Response>((_resolve, reject) => {
      upstreamSignal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  };
  const ask = createTypeSafeEvaluator({ apiKey: API_KEY, fetch: fetcher, timeoutMs: 30 });
  await assert.rejects(ask(state, questions, MODEL), expectedError('TYPESAFE_TIMEOUT'));
  assert.equal(upstreamSignal?.aborted, true);
});

test('the timeout covers a stalled response body and cancels its stream', { timeout: 1500 }, async () => {
  let cancelled = false;
  let upstreamSignal: AbortSignal | null | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
    cancel() { cancelled = true; },
  });
  const ask = createTypeSafeEvaluator({
    apiKey: API_KEY,
    timeoutMs: 30,
    fetch: async (_input, init) => {
      upstreamSignal = init?.signal;
      return new Response(stream, { headers: { 'content-type': 'application/json' } });
    },
  });
  await assert.rejects(ask(state, questions, MODEL), expectedError('TYPESAFE_TIMEOUT'));
  assert.equal(upstreamSignal?.aborted, true);
  assert.equal(cancelled, true);
});

test('caller abort during response-body consumption cancels the stream', { timeout: 1500 }, async () => {
  const reading = deferred<void>();
  const controller = new AbortController();
  let cancelled = false;
  let upstreamSignal: AbortSignal | null | undefined;
  const stream = new ReadableStream<Uint8Array>({
    pull() { reading.resolve(); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const ask = createTypeSafeEvaluator({
    apiKey: API_KEY,
    timeoutMs: 1000,
    fetch: async (_input, init) => {
      upstreamSignal = init?.signal;
      return new Response(stream, { headers: { 'content-type': 'application/json' } });
    },
  });
  const pending = ask(state, questions, MODEL, controller.signal);
  await reading.promise;
  controller.abort();
  await assert.rejects(pending, expectedError('TYPESAFE_ABORTED'));
  assert.equal(upstreamSignal?.aborted, true);
  assert.equal(cancelled, true);
});

test('rejects a request larger than 2 MiB before fetch', async () => {
  let calls = 0;
  const ask = createTypeSafeEvaluator({
    apiKey: API_KEY,
    fetch: async () => { calls += 1; return jsonResponse(validResult); },
  });
  await assert.rejects(
    ask({ text: 'x'.repeat(2 * 1024 * 1024) }, questions, MODEL),
    expectedError('TYPESAFE_REQUEST_TOO_LARGE'),
  );
  assert.equal(calls, 0);
});

test('request limit counts UTF-8 bytes rather than JavaScript characters', async () => {
  let calls = 0;
  const text = '한'.repeat(710_000);
  assert.ok(text.length < 2 * 1024 * 1024);
  assert.ok(new TextEncoder().encode(text).length > 2 * 1024 * 1024);
  const ask = createTypeSafeEvaluator({
    apiKey: API_KEY,
    fetch: async () => { calls += 1; return jsonResponse(validResult); },
  });
  await assert.rejects(ask({ text }, questions, MODEL), expectedError('TYPESAFE_REQUEST_TOO_LARGE'));
  assert.equal(calls, 0);
});

test('rejects an advertised response larger than 1 MiB and cancels it', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const ask = createTypeSafeEvaluator({
    apiKey: API_KEY,
    fetch: async () => new Response(stream, {
      headers: { 'content-type': 'application/json', 'content-length': String(1024 * 1024 + 1) },
    }),
  });
  await assert.rejects(ask(state, questions, MODEL), expectedError('TYPESAFE_RESPONSE_TOO_LARGE'));
  assert.equal(cancelled, true);
});

test('enforces the streamed response limit when Content-Length is absent', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
    cancel() { cancelled = true; },
  });
  const ask = createTypeSafeEvaluator({
    apiKey: API_KEY,
    fetch: async () => new Response(stream, { headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(ask(state, questions, MODEL), expectedError('TYPESAFE_RESPONSE_TOO_LARGE'));
  assert.equal(cancelled, true);
});

test('enforces the streamed response limit despite a false small Content-Length', async () => {
  const ask = createTypeSafeEvaluator({
    apiKey: API_KEY,
    fetch: async () => new Response('x'.repeat(1024 * 1024 + 1), {
      headers: { 'content-type': 'application/json', 'content-length': '1' },
    }),
  });
  await assert.rejects(ask(state, questions, MODEL), expectedError('TYPESAFE_RESPONSE_TOO_LARGE'));
});

test('counts the total response bytes across individually small chunks', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(600_000));
      controller.enqueue(new Uint8Array(600_000));
    },
    cancel() { cancelled = true; },
  });
  const ask = createTypeSafeEvaluator({
    apiKey: API_KEY,
    fetch: async () => new Response(stream, { headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(ask(state, questions, MODEL), expectedError('TYPESAFE_RESPONSE_TOO_LARGE'));
  assert.equal(cancelled, true);
});

test('response limit counts UTF-8 bytes before decoding multibyte text', async () => {
  const text = '한'.repeat(350_000);
  assert.ok(text.length < 1024 * 1024);
  assert.ok(new TextEncoder().encode(text).length > 1024 * 1024);
  const ask = createTypeSafeEvaluator({
    apiKey: API_KEY,
    fetch: async () => new Response(text, { headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(ask(state, questions, MODEL), expectedError('TYPESAFE_RESPONSE_TOO_LARGE'));
});

test('rejects malformed UTF-8 rather than replacing invalid bytes silently', async () => {
  const ask = createTypeSafeEvaluator({
    apiKey: API_KEY,
    fetch: async () => new Response(new Uint8Array([0xc3, 0x28]), {
      headers: { 'content-type': 'application/json' },
    }),
  });
  await assert.rejects(ask(state, questions, MODEL), expectedError('TYPESAFE_INVALID_RESPONSE'));
});

test('decodes valid UTF-8 split across response chunks', async () => {
  const response = { ...validResult, model: 'jev-한글-model' };
  const encoded = new TextEncoder().encode(JSON.stringify(response));
  const firstMultibyte = encoded.findIndex((byte) => byte >= 0x80);
  assert.ok(firstMultibyte >= 0);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded.subarray(0, firstMultibyte + 1));
      controller.enqueue(encoded.subarray(firstMultibyte + 1));
      controller.close();
    },
  });
  const ask = createTypeSafeEvaluator({
    apiKey: API_KEY,
    fetch: async () => new Response(stream, { headers: { 'content-type': 'application/json' } }),
  });
  assert.deepEqual(await ask(state, questions, MODEL), { ...response, provider: 'typesafe' });
});

test('cyclic state fails encoding before fetch without leaking its values', async () => {
  let calls = 0;
  const cyclic: Record<string, unknown> = { privateValue: API_KEY };
  cyclic.self = cyclic;
  const ask = createTypeSafeEvaluator({
    apiKey: API_KEY,
    fetch: async () => { calls += 1; return jsonResponse(validResult); },
  });
  await assert.rejects(ask(cyclic, questions, MODEL), expectedError('TYPESAFE_INVALID_REQUEST'));
  assert.equal(calls, 0);
});

for (const apiKey of ['', '   ', 'private-key\r\nInjected: header']) {
  test('rejects invalid API key configuration', () => {
    assert.throws(
      () => createTypeSafeEvaluator({ apiKey }),
      expectedError('TYPESAFE_CONFIGURATION_ERROR'),
    );
  });
}

for (const timeoutMs of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
  test(`rejects invalid timeout configuration: ${String(timeoutMs)}`, () => {
    assert.throws(
      () => createTypeSafeEvaluator({ apiKey: API_KEY, timeoutMs }),
      expectedError('TYPESAFE_CONFIGURATION_ERROR'),
    );
  });
}
