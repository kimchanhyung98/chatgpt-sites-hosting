import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createServer } from '../src/server.ts';
import { createTypeSafeEvaluator } from '../src/infrastructure/typesafe.ts';
import { createRegexRunner } from '../src/infrastructure/re2-regex.ts';

const usage = { input_tokens: 42, output_tokens: 8 };

async function withProvider(answerFactory, run) {
  const requests = [];
  const ask = createTypeSafeEvaluator({
    apiKey: 'local-test-key',
    fetch: async (input, init) => {
      assert.equal(String(input), 'https://api.typesafe.ai/v1/systemone');
      const body = JSON.parse(await new Response(init.body).text());
      requests.push(body);
      return Response.json({ answers: answerFactory(body.questions), model: 'jev-resolved-test', usage });
    },
  });
  const server = createServer({ model: 'jev-latest', ask, runRegex: createRegexRunner() });
  const client = new Client({ name: 'jev-provider-integration', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await run(client, requests);
  } finally {
    await client.close();
    await server.close();
  }
}

function payload(result) {
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  const content = result.content.find((block) => block.type === 'text');
  assert.ok(content);
  return JSON.parse(content.text);
}

function validAnswers(questions) {
  return Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    if (question.type === 'noul') return [id, { type: 'noul', noul: 0.95 }];
    if (question.type === 'choice') {
      const keys = Object.keys(question.criteria);
      return [id, { type: 'choice', choice: keys[0], confidence: 0.99, probabilities: Object.fromEntries(keys.map((key, index) => [key, index === 0 ? 1 : 0])) }];
    }
    assert.equal(question.type, 'score');
    const value = /(?:test_gap|blast_radius)$/.test(id) ? 0 : question.criteria.length - 1;
    return [id, {
      type: 'score', score: value, confidence: 0.99,
      legend: Object.fromEntries(question.criteria.map((level, index) => [String(index), level])),
      probabilities: Object.fromEntries(question.criteria.map((_, index) => [String(index), index === value ? 1 : 0])),
    }];
  }));
}

const classification = {
  items: [{ id: 'charge', text: 'Charged twice.' }, { id: 'bug', text: 'The app crashes.' }],
  classes: [{ id: 'billing', description: 'Payment requests' }, { id: 'technical', description: 'Technical requests' }],
};
const decision = {
  decision: 'Which database should be used?', evidence: 'One writer and one table.', priorities: 'Minimal operations.',
  candidates: [{ id: 'sqlite', description: 'Embedded database' }, { id: 'postgres', description: 'Database server' }],
};
const review = { request: 'Reject empty input.', diff: '+ if (!input) throw Error();', tests: 'Empty input test passed.' };

for (const mode of ['missing', 'malformed']) {
  test(`the production provider preserves a valid classify sibling when another answer is ${mode}`, async () => {
    await withProvider((questions) => {
      const answers = validAnswers(questions);
      if (mode === 'missing') delete answers.i0;
      else answers.i0.probabilities = { c0: 1.2, c1: -0.2 };
      answers.i1 = { type: 'choice', choice: 'c1', confidence: 0.99, probabilities: { c0: 0, c1: 1 } };
      return answers;
    }, async (client, requests) => {
      const result = payload(await client.callTool({ name: 'jev_classify', arguments: classification }));
      assert.equal(result.results[0].status, 'invalid_response');
      assert.equal(result.results[0].decision, 'review');
      assert.equal(result.results[1].classification, 'technical');
      assert.equal(result.results[1].decision, 'auto');
      assert.deepEqual(result.summary, { items: 2, auto: 1, review: 0, invalid_response: 1, by_class: { technical: 1 } });
      assert.deepEqual(result.usage, usage);
      assert.equal(requests.length, 1);
    });
  });
}

for (const confidence of [undefined, null]) {
  test(`the production provider retains verify judgment and requests review for confidence=${String(confidence)}`, async () => {
    await withProvider((questions) => {
      const answers = validAnswers(questions);
      answers.relation_claim0.confidence = confidence;
      return answers;
    }, async (client, requests) => {
      const result = payload(await client.callTool({ name: 'jev_verify', arguments: { claims: ['The test passed.'], evidence: 'Test passed.' } }));
      assert.equal(result.results[0].verdict, 'verified');
      assert.equal(result.results[0].confidence, null);
      assert.equal(result.results[0].action, 'review');
      assert.equal(result.results[0].status, undefined);
      assert.equal(requests.length, 1);
    });
  });
}

test('the production provider keeps a decide selection when confidence is unknown', async () => {
  await withProvider((questions) => {
    const answers = validAnswers(questions);
    answers.recommendation.confidence = null;
    return answers;
  }, async (client) => {
    const result = payload(await client.callTool({ name: 'jev_decide', arguments: decision }));
    assert.equal(result.recommendation.selected, 'sqlite');
    assert.equal(result.recommendation.confidence, null);
    assert.equal(result.recommendation.status, undefined);
  });
});

test('the production provider preserves optional review score distributions', async () => {
  await withProvider((questions) => {
    const answers = validAnswers(questions);
    for (const answer of Object.values(answers)) {
      if (answer.type === 'score') {
        delete answer.probabilities;
        delete answer.legend;
      }
    }
    return answers;
  }, async (client) => {
    const result = payload(await client.callTool({ name: 'jev_review', arguments: review }));
    assert.equal(result.action, 'auto');
    assert.equal(result.composite, 1);
    assert.equal(result.scores.correctness.probabilities, null);
    assert.equal(result.status, undefined);
  });
});

test('explicit answer type mismatches invalidate only that community judgment', async () => {
  await withProvider((questions) => {
    const answers = validAnswers(questions);
    answers.i0.type = 'noul';
    return answers;
  }, async (client) => {
    const result = payload(await client.callTool({ name: 'jev_classify', arguments: classification }));
    assert.equal(result.results[0].status, 'invalid_response');
    assert.equal(result.results[1].status, undefined);
    assert.equal(result.summary.invalid_response, 1);
  });
});

test('unexpected answer ids invalidate the community response envelope', async () => {
  await withProvider((questions) => ({ ...validAnswers(questions), unexpected: { type: 'noul', noul: 0.9 } }), async (client) => {
    const result = payload(await client.callTool({ name: 'jev_classify', arguments: classification }));
    assert.equal(result.summary.invalid_response, 2);
    assert.equal(result.summary.auto, 0);
  });
});

const communityCalls = [
  ['jev_verify', { claims: ['Tests passed.'], evidence: 'Tests passed.' }],
  ['jev_screen', { text: 'The release is available.' }],
  ['jev_noul', { propositions: ['Tests passed.'] }],
  ['jev_find', { query: 'Test result', candidates: [{ id: 'test', text: 'Tests passed.' }, { id: 'other', text: 'Other notes.' }] }],
  ['jev_classify', classification],
  ['jev_decide', decision],
  ['jev_rerank', { query: 'Test result', candidates: [{ id: 'test', text: 'Tests passed.' }] }],
  ['jev_compare', { passage_a: 'Version one.', passage_b: 'Version one.' }],
  ['jev_extract', { document: 'Invoice 123', fields: [{ id: 'invoice', description: 'Invoice number', pattern: '[0-9]+' }] }],
  ['jev_audit', { source: 'Invoice 123', records: [{ id: 'invoice', request: 'Invoice number', value: '123' }] }],
  ['jev_review', review],
  ['jev_gate', { ...review, claims: ['Tests passed.'], evidence: 'Tests passed.' }],
];

for (const [name, args] of communityCalls) {
  test(`${name} succeeds through SDK question constructors and the production provider`, async () => {
    await withProvider(validAnswers, async (client, requests) => {
      const result = payload(await client.callTool({ name, arguments: args }));
      assert.equal(result.tool, name);
      assert.equal(result.model, 'jev-resolved-test');
      assert.equal(result.provider, 'typesafe');
      assert.deepEqual(result.usage, usage);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].model, 'jev-latest');
      assert.ok(Object.keys(requests[0].questions).length > 0);
    });
  });
}
