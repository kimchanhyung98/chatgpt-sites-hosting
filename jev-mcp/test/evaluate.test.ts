import assert from 'node:assert/strict';
import test from 'node:test';
import type { McpServer } from '@modelcontextprotocol/server';
import { evaluateInputSchema, registerEvaluateTool } from '../src/application/evaluate.js';
import { validateAnswers, validateEvaluationEnvelope } from '../src/domain/answers.js';

type Runtime = Parameters<typeof registerEvaluateTool>[1];
type Result = {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
type Handler = (input: unknown, context: { mcpReq: { signal: AbortSignal } }) => Promise<Result>;

function mixedInput() {
  return {
    state: { text: 'A proposed change and its test output.', artifacts: ['patch', null, 2, true] },
    questions: {
      supported: { type: 'noul', instructions: 'Does the evidence support the claim?', criteria: { true: 'Supported', false: null } },
      route: { type: 'choice', instructions: { task: 'Pick one route.' }, criteria: { accept: 'Relevant', skip: null } },
      quality: { type: 'score', instructions: ['Rate the quality.'], criteria: ['low', { label: 'medium' }, ['high']] },
    },
  };
}

function evaluation() {
  return {
    model: 'jev-release-123',
    provider: 'typesafe' as const,
    answers: {
      supported: { type: 'noul', noul: 0.91 },
      route: { type: 'choice', choice: 'accept', confidence: 0.87, probabilities: { accept: 0.93, skip: 0.07 } },
      quality: {
        type: 'score', score: 0.7, confidence: 0.82,
        probabilities: { '0': 0.6, '1': 0.1, '2': 0.3 },
        legend: { '0': 'low', '1': { label: 'medium' }, '2': ['high'] },
      },
    },
    usage: { input_tokens: 123, output_tokens: 7 },
  };
}

async function parseInput(input: unknown) {
  const parsed = await evaluateInputSchema['~standard'].validate(input);
  if (parsed.issues) assert.fail(JSON.stringify(parsed.issues));
  return parsed.value;
}

async function rejectsInput(input: unknown, label: string) {
  const parsed = await evaluateInputSchema['~standard'].validate(input);
  assert.ok(parsed.issues && parsed.issues.length > 0, label);
}

function registeredTool(ask: Runtime['ask']) {
  let callback: Handler | undefined;
  const names: string[] = [];
  const server = {
    registerTool(name: string, _config: unknown, handler: Handler) {
      names.push(name);
      callback = handler;
    },
  } as unknown as McpServer;
  const runtime = {
    model: 'jev-latest',
    ask,
    runRegex: async () => { throw new Error('Generic evaluation must not use regex.'); },
  } as Runtime;
  registerEvaluateTool(server, runtime);
  assert.deepEqual(names, ['jev_evaluate']);
  assert.ok(callback);
  const handler = callback;
  return async (input: unknown, signal = new AbortController().signal) => handler(await parseInput(input), { mcpReq: { signal } });
}

test('evaluate accepts one mixed question set and preserves nested entry values', async () => {
  const input = mixedInput();
  assert.deepEqual(await parseInput(input), input);
  for (const state of ['', [], {}, ['a', null, { number: 1 }]]) {
    const candidate = { state, questions: { q: { type: 'noul' } } };
    assert.deepEqual(await parseInput(candidate), candidate);
  }
  for (const criteria of [undefined, null, {}, { true: null }, { false: ['no'] }]) {
    const question = criteria === undefined ? { type: 'noul' } : { type: 'noul', criteria };
    await parseInput({ state: 'text', questions: { q: question } });
  }
});

test('evaluate rejects non-context states and unexpected request controls', async () => {
  for (const state of [null, true, 1]) {
    await rejectsInput({ state, questions: { q: { type: 'noul' } } }, `invalid state ${String(state)}`);
  }
  const input = mixedInput();
  for (const key of ['model', 'instructions', 'apiKey', 'api_key', 'endpoint', 'baseURL', 'timeout']) {
    await rejectsInput({ ...input, [key]: 'caller-controlled' }, `unexpected top-level ${key}`);
  }
  await rejectsInput({ questions: input.questions }, 'missing state');
  await rejectsInput({ state: input.state }, 'missing questions');
});

test('evaluate enforces question, choice, score, and label limits', async () => {
  const questions = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`q${i}`, { type: 'noul' }]));
  const choices = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`label${i}`, null]));
  await parseInput({ state: 'text', questions: questions(32) });
  await rejectsInput({ state: 'text', questions: questions(0) }, 'empty questions');
  await rejectsInput({ state: 'text', questions: questions(33) }, 'more than 32 questions');
  await parseInput({ state: 'text', questions: { q: { type: 'choice', criteria: choices(255) } } });
  await rejectsInput({ state: 'text', questions: { q: { type: 'choice', criteria: choices(1) } } }, 'only one choice');
  await rejectsInput({ state: 'text', questions: { q: { type: 'choice', criteria: choices(256) } } }, 'more than 255 choices');
  await parseInput({ state: 'text', questions: { q: { type: 'score', criteria: Array.from({ length: 10 }, (_, i) => String(i)) } } });
  await rejectsInput({ state: 'text', questions: { q: { type: 'score', criteria: ['only'] } } }, 'only one score level');
  await rejectsInput({ state: 'text', questions: { q: { type: 'score', criteria: Array.from({ length: 11 }, (_, i) => String(i)) } } }, 'more than 10 score levels');
  for (const id of ['', 'a'.repeat(129)]) {
    await rejectsInput({ state: 'text', questions: { [id]: { type: 'noul' } } }, 'invalid question ID length');
    await rejectsInput({ state: 'text', questions: { q: { type: 'choice', criteria: { [id]: 'first', valid: 'second' } } } }, 'invalid choice label length');
  }
  await parseInput({ state: 'text', questions: { ['a'.repeat(128)]: { type: 'choice', criteria: { ['b'.repeat(128)]: null, other: null } } } });
});

test('evaluate rejects mismatched criteria and unknown question fields', async () => {
  const invalidQuestions = [
    { type: 'unknown' },
    { type: 'noul', options: ['yes', 'no'] },
    { type: 'noul', criteria: { other: 'not a boolean label' } },
    { type: 'noul', criteria: ['yes', 'no'] },
    { type: 'noul', instructions: false },
    { type: 'noul', instructions: 3 },
    { type: 'choice' },
    { type: 'choice', criteria: ['first', 'second'] },
    { type: 'choice', criteria: { first: false, second: 'text' } },
    { type: 'score' },
    { type: 'score', criteria: { '0': 'low', '1': 'high' } },
    { type: 'score', criteria: ['low', null] },
    { type: 'score', criteria: ['low', 3] },
    { type: 'score', criteria: ['low', 'high'], endpoint: 'https://unexpected.invalid' },
  ];
  for (const question of invalidQuestions) {
    await rejectsInput({ state: 'text', questions: { q: question } }, JSON.stringify(question));
  }
});

test('evaluate preserves whitespace, punctuation, Unicode, and ordinary prototype-name keys', async () => {
  const keys = [' spaced?! ', '한글/雪', 'constructor', 'toString'];
  const criteria = Object.fromEntries(keys.map(key => [key, `Description of ${key}`]));
  const questions = Object.fromEntries(keys.map(key => [key, { type: 'choice', criteria }]));
  const parsed = await parseInput({ state: 'text', questions });
  assert.deepEqual(parsed.questions, questions);
  assert.deepEqual(Object.keys(parsed.questions), keys);
});

test('evaluate rejects oversized aggregate UTF-8 payloads and excessive nesting', async () => {
  await rejectsInput({ state: 'a'.repeat(80_000), questions: { q: { type: 'noul', instructions: 'b'.repeat(80_000) } } }, 'aggregate payload exceeds 128 KiB');
  await rejectsInput({ state: '한'.repeat(50_000), questions: { q: { type: 'noul' } } }, 'UTF-8 byte budget, not character count');
  let nested: unknown = 'leaf';
  for (let depth = 0; depth < 40; depth += 1) nested = [nested];
  await rejectsInput({ state: nested, questions: { q: { type: 'noul' } } }, 'state nesting exceeds 32');
  await rejectsInput({ state: 'text', questions: { q: { type: 'noul', instructions: nested } } }, 'instructions nesting exceeds 32');
});

test('evaluate makes one mixed upstream request and preserves provider judgments and usage', async () => {
  const input = mixedInput();
  const upstream = evaluation();
  const calls: unknown[][] = [];
  const signal = new AbortController().signal;
  const invoke = registeredTool(async (state, questions, model, requestSignal) => {
    calls.push([state, questions, model, requestSignal]);
    return upstream;
  });
  const result = await invoke(input, signal);
  assert.deepEqual(calls, [[input.state, input.questions, 'jev-latest', signal]]);
  assert.notEqual(result.isError, true);
  assert.ok(result.structuredContent);
  assert.equal(result.structuredContent.provider, upstream.provider);
  assert.equal(result.structuredContent.model, upstream.model);
  assert.deepEqual(result.structuredContent.answers, upstream.answers);
  assert.deepEqual(result.structuredContent.usage, upstream.usage);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0]?.type, 'text');
  assert.deepEqual(JSON.parse(result.content[0]?.text ?? ''), result.structuredContent);
});

test('evaluate propagates in-flight MCP cancellation without returning a successful judgment', { timeout: 1_000 }, async () => {
  const controller = new AbortController();
  let notifyStarted: (() => void) | undefined;
  const started = new Promise<void>(resolve => { notifyStarted = resolve; });
  const invoke = registeredTool(async (_state, _questions, _model, signal) => {
    assert.equal(signal, controller.signal);
    notifyStarted?.();
    await new Promise<never>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    return evaluation();
  });
  const pending = invoke(mixedInput(), controller.signal);
  await started;
  controller.abort(new Error('private-cancellation-reason'));
  const result = await pending;
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
  assert.ok(!JSON.stringify(result).includes('private-cancellation-reason'));
});

test('evaluate does not start cancelled work or accept an upstream result after cancellation', { timeout: 1_000 }, async () => {
  const alreadyCancelled = new AbortController();
  alreadyCancelled.abort();
  let calls = 0;
  const blocked = registeredTool(async () => { calls += 1; return evaluation(); });
  assert.equal((await blocked(mixedInput(), alreadyCancelled.signal)).isError, true);
  assert.equal(calls, 0);

  const duringRequest = new AbortController();
  let notifyStarted: (() => void) | undefined;
  let release: (() => void) | undefined;
  const started = new Promise<void>(resolve => { notifyStarted = resolve; });
  const finish = new Promise<void>(resolve => { release = resolve; });
  const slow = registeredTool(async () => {
    notifyStarted?.();
    await finish;
    return evaluation();
  });
  const pending = slow(mixedInput(), duringRequest.signal);
  await started;
  duringRequest.abort();
  release?.();
  const result = await pending;
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
});

test('evaluate returns the same fixed error for private upstream failures', async () => {
  const first = registeredTool(async () => { throw new Error('api-key=secret-first-token; private upstream body'); });
  const second = registeredTool(async () => { throw new Error('api-key=secret-second-token; Authorization header'); });
  const firstResult = await first(mixedInput());
  const secondResult = await second(mixedInput());
  assert.equal(firstResult.isError, true);
  assert.equal(firstResult.structuredContent, undefined);
  assert.deepEqual(firstResult, secondResult);
  assert.ok(!JSON.stringify(firstResult).includes('secret-first-token'));
  assert.ok(!JSON.stringify(secondResult).includes('secret-second-token'));
});

test('answer validation accepts the original mixed provider result without synthesizing confidence', () => {
  const upstream = evaluation();
  assert.doesNotThrow(() => validateAnswers(mixedInput().questions, upstream));
  assert.equal(Object.hasOwn(upstream.answers.supported, 'confidence'), false);
});

test('envelope validation preserves incomplete and malformed item answers for each tool policy', () => {
  const upstream = evaluation();
  const answerMaps: Array<Record<string, unknown>> = [
    {},
    { supported: upstream.answers.supported },
    { supported: null, route: 'invalid', quality: { type: 'score', score: 20 } },
    { ...upstream.answers, unexpected: { type: 'noul', noul: 2 } },
  ];
  for (const answers of answerMaps) {
    const result = validateEvaluationEnvelope({ ...upstream, answers });
    assert.equal(result.answers, answers);
    assert.deepEqual(result.usage, upstream.usage);
    assert.equal(result.model, upstream.model);
    assert.throws(() => validateAnswers(mixedInput().questions, { ...upstream, answers }));
  }
});

test('envelope validation still rejects malformed accounting and non-object answer envelopes', () => {
  const upstream = evaluation();
  for (const value of [
    null,
    { ...upstream, answers: null },
    { ...upstream, answers: [] },
    { ...upstream, answers: 'invalid' },
    { ...upstream, model: '' },
    { ...upstream, usage: { input_tokens: 5 } },
    { ...upstream, usage: { input_tokens: -1, output_tokens: 0 } },
  ]) {
    assert.throws(() => validateEvaluationEnvelope(value), { message: 'Invalid TypeSafe response.' });
  }
});

test('answer validation rejects missing, extra, or mistyped answers', () => {
  const questionSet = mixedInput().questions;
  const upstream = evaluation();
  const { supported: _supported, ...missing } = upstream.answers;
  const malformed = [
    null,
    { ...upstream, answers: null },
    { ...upstream, answers: [upstream.answers.supported] },
    { ...upstream, answers: missing },
    { ...upstream, answers: { ...upstream.answers, unexpected: { type: 'noul', noul: 0.2 } } },
    { ...upstream, answers: { ...upstream.answers, supported: { type: 'choice', noul: 0.91 } } },
  ];
  for (const value of malformed) assert.throws(() => validateAnswers(questionSet, value));
});

test('answer validation rejects non-finite and out-of-range probability or confidence', () => {
  const questionSet = mixedInput().questions;
  for (const value of [NaN, Infinity, -Infinity, -0.01, 1.01, '0.9', null]) {
    const upstream = evaluation();
    const malformedNoul = { ...upstream, answers: { ...upstream.answers, supported: { type: 'noul', noul: value } } };
    const malformedConfidence = { ...upstream, answers: { ...upstream.answers, route: { ...upstream.answers.route, confidence: value } } };
    const malformedProbability = { ...upstream, answers: { ...upstream.answers, route: { ...upstream.answers.route, probabilities: { accept: value, skip: 0.07 } } } };
    assert.throws(() => validateAnswers(questionSet, malformedNoul), `noul ${String(value)}`);
    assert.throws(() => validateAnswers(questionSet, malformedConfidence), `confidence ${String(value)}`);
    assert.throws(() => validateAnswers(questionSet, malformedProbability), `probability ${String(value)}`);
  }
});

test('answer validation requires offered choices and complete normalized distributions', () => {
  const questionSet = mixedInput().questions;
  const upstream = evaluation();
  const invalidRoutes = [
    { ...upstream.answers.route, choice: 'invented' },
    { ...upstream.answers.route, choice: 'skip' },
    { ...upstream.answers.route, probabilities: { accept: 1 } },
    { ...upstream.answers.route, probabilities: { accept: 0.8, skip: 0.1, extra: 0.1 } },
    { ...upstream.answers.route, probabilities: { accept: 0.4, skip: 0.4 } },
    { ...upstream.answers.route, probabilities: { accept: 0.6, skip: 0.44 } },
  ];
  for (const route of invalidRoutes) {
    assert.throws(() => validateAnswers(questionSet, { ...upstream, answers: { ...upstream.answers, route } }));
  }
  const roundedRoute = { ...upstream.answers.route, probabilities: { accept: 0.93, skip: 0.08 } };
  assert.doesNotThrow(() => validateAnswers(questionSet, { ...upstream, answers: { ...upstream.answers, route: roundedRoute } }));
  for (const choice of ['accept', 'skip']) {
    const tied = { ...upstream.answers.route, choice, probabilities: { accept: 0.5, skip: 0.5000000001 } };
    assert.doesNotThrow(() => validateAnswers(questionSet, { ...upstream, answers: { ...upstream.answers, route: tied } }));
  }
});

test('answer validation bounds scores and requires complete non-null legends', () => {
  const questionSet = mixedInput().questions;
  const upstream = evaluation();
  const invalidScores = [
    ...[-0.01, 2.01, NaN, Infinity, '1'].map(score => ({ ...upstream.answers.quality, score })),
    { ...upstream.answers.quality, score: 1.7 },
    { ...upstream.answers.quality, legend: { '0': 'high', '1': { label: 'medium' }, '2': ['low'] } },
    { ...upstream.answers.quality, probabilities: { low: 0.6, medium: 0.1, high: 0.3 } },
    { ...upstream.answers.quality, legend: { '0': 'low', '1': 'medium' } },
    { ...upstream.answers.quality, legend: { '0': 'low', '1': 'medium', '2': null } },
    { ...upstream.answers.quality, legend: { '0': 'low', '1': 'medium', '2': false } },
    { ...upstream.answers.quality, legend: { '0': 'low', '1': 'medium', '2': 'high', '3': 'extra' } },
  ];
  for (const quality of invalidScores) {
    assert.throws(() => validateAnswers(questionSet, { ...upstream, answers: { ...upstream.answers, quality } }));
  }
});

test('answer validation preserves nested score criteria regardless of object key order', () => {
  const criteria = ['low', { label: 'medium', examples: ['first', { second: true }] }, ['high']];
  const questions = { quality: { type: 'score', criteria } };
  const quality = { ...evaluation().answers.quality, score: 0.72, legend: {
    '0': 'low', '1': { examples: ['first', { second: true }], label: 'medium' }, '2': ['high'],
  } };
  const upstream = { ...evaluation(), answers: { quality } };
  assert.doesNotThrow(() => validateAnswers(questions, upstream));
  quality.legend['1'].examples.reverse();
  assert.throws(() => validateAnswers(questions, upstream));
});

test('answer validation allows rounded ten-level scores but rejects contradictory means', () => {
  const criteria = Array.from({ length: 10 }, (_, i) => `level ${i}`);
  const quality = {
    type: 'score', score: 6.65, confidence: 0.5,
    legend: Object.fromEntries(criteria.map((value, index) => [index, value])),
    probabilities: Object.fromEntries(criteria.map((_, index) => [index, index < 5 ? 0.01 : 0.19])),
  };
  const questions = { quality: { type: 'score', criteria } };
  const upstream = { ...evaluation(), answers: { quality } };
  assert.doesNotThrow(() => validateAnswers(questions, upstream));
  quality.score = 6.4;
  assert.throws(() => validateAnswers(questions, upstream));
});

test('answer validation rejects invalid model and unsafe token accounting', () => {
  const questionSet = mixedInput().questions;
  const upstream = evaluation();
  for (const model of ['', 'a'.repeat(257), null, 3]) {
    assert.throws(() => validateAnswers(questionSet, { ...upstream, model }), `model ${String(model)}`);
  }
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
    for (const key of ['input_tokens', 'output_tokens']) {
      assert.throws(() => validateAnswers(questionSet, { ...upstream, usage: { ...upstream.usage, [key]: value } }), `${key} ${String(value)}`);
    }
  }
  assert.doesNotThrow(() => validateAnswers(questionSet, { ...upstream, model: 'a'.repeat(256), usage: { input_tokens: 0, output_tokens: 0 } }));
});

test('evaluate fails closed when a resolved upstream response is malformed', async () => {
  const upstream = evaluation();
  const ask = (async () => ({ ...upstream, answers: { ...upstream.answers, route: { ...upstream.answers.route, choice: 'unoffered-secret-option' } } })) as Runtime['ask'];
  const result = await registeredTool(ask)(mixedInput());
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
  assert.ok(!JSON.stringify(result).includes('unoffered-secret-option'));
});
