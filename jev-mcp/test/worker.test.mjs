import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { CLIENT_CAPABILITIES_META_KEY, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/server';
import { Miniflare, Response as WorkerResponse } from 'miniflare';

const ORIGIN = 'https://jev.test';
const API_KEY = 'synthetic-worker-test-key';
const VERSION = '2025-11-25';
const NAMES = [
  'jev_audit', 'jev_classify', 'jev_compare', 'jev_decide', 'jev_evaluate',
  'jev_extract', 'jev_find', 'jev_gate', 'jev_noul', 'jev_rerank',
  'jev_review', 'jev_screen', 'jev_verify',
];
const NO_MATCH = {
  document: 'There are no digits here.',
  fields: [{ id: 'amount', description: 'The amount', pattern: '\\d+' }],
};
const MIXED = {
  state: { text: 'A user requested a refund for an unusable product.' },
  questions: {
    category: { type: 'choice', instructions: 'Classify the request.', criteria: { refund: 'Money back', support: 'Technical assistance' } },
    quality: { type: 'score', instructions: 'Rate the product usability.', criteria: ['Unusable', 'Limited', 'Usable'] },
    actionable: { type: 'noul', instructions: 'Does the user request an action?' },
  },
};
const ANSWERS = {
  category: { type: 'choice', choice: 'refund', confidence: 0.9, probabilities: { refund: 0.95, support: 0.05 } },
  quality: { type: 'score', score: 0.2, confidence: 0.8, legend: { 0: 'Unusable', 1: 'Limited', 2: 'Usable' }, probabilities: { 0: 0.8, 1: 0.2, 2: 0 } },
  actionable: { type: 'noul', noul: 0.97 },
};

function envelope(method, params = {}, id = 1) {
  return { jsonrpc: '2.0', id, method, params };
}

async function fixture(t, { configured = true, upstream } = {}) {
  const calls = [];
  const worker = new Miniflare({
    telemetry: { enabled: false },
    logRequests: false,
    workers: [{
      config: {
        name: 'jev-worker-test',
        compatibilityDate: '2026-10-01',
        manifest: {
          mainModule: 'index.js',
          modules: { 'index.js': { type: 'esm', contents: readFileSync(resolve('dist/server/index.js'), 'utf8') } },
        },
        env: configured ? {
          TYPESAFE_API_KEY: { type: 'text', value: API_KEY },
          JEV_MCP_MODEL: { type: 'text', value: 'jev-test-model' },
        } : {},
      },
      dev: {
        outboundService: {
          type: 'fetcher',
          handler: async (request) => {
            const call = {
              url: request.url,
              method: request.method,
              headers: Object.fromEntries(request.headers),
              body: JSON.parse(await request.text()),
            };
            calls.push(call);
            if (!upstream) return new WorkerResponse('Unexpected outbound request', { status: 599 });
            return upstream(call);
          },
        },
      },
    }],
  });
  t.after(() => worker.dispose());
  await worker.ready;
  return { worker, calls };
}

function request(worker, body, { path = '/mcp', headers = {}, authenticated = true, method = 'POST' } = {}) {
  return worker.dispatchFetch(`${ORIGIN}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': VERSION,
      ...(authenticated ? { 'oai-authenticated-user-id': 'synthetic-test-user' } : {}),
      ...headers,
    },
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}

async function rpc(response) {
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const messages = text.split(/\r?\n/).filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
    return messages.find((message) => Object.hasOwn(message, 'id'));
  }
  return JSON.parse(text);
}

async function call(worker, name, args) {
  return rpc(await request(worker, envelope('tools/call', { name, arguments: args })));
}

function toolData(reply) {
  assert.equal(reply.error, undefined, JSON.stringify(reply));
  assert.notEqual(reply.result.isError, true, JSON.stringify(reply.result));
  return JSON.parse(reply.result.content[0].text);
}

function assertToolCatalog(tools) {
  assert.deepEqual(tools.map((tool) => tool.name).sort(), NAMES);
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string', tool.name);
    assert.ok(tool.description.trim().length > 0, tool.name);
    assert.equal(tool.inputSchema.type, 'object', tool.name);
    assert.ok(Object.keys(tool.inputSchema.properties).length > 0, tool.name);
    assert.ok(tool.inputSchema.required.length > 0, tool.name);
    for (const required of tool.inputSchema.required) {
      assert.ok(Object.hasOwn(tool.inputSchema.properties, required), `${tool.name}.${required}`);
    }
    assert.deepEqual(tool.annotations, {
      readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    }, tool.name);
  }
  assert.equal(tools.find((tool) => tool.name === 'jev_find').inputSchema.properties.candidates.minItems, 2);
  assert.ok(tools.find((tool) => tool.name === 'jev_evaluate').outputSchema);
}

test('production Worker negotiates legacy MCP, lists 13 tools and extracts without outbound calls', async (t) => {
  const { worker, calls } = await fixture(t);
  const initialized = await rpc(await request(worker, envelope('initialize', {
    protocolVersion: VERSION, capabilities: {}, clientInfo: { name: 'worker-tests', version: '1' },
  })));
  assert.equal(initialized.result.protocolVersion, VERSION);
  assert.equal(initialized.result.serverInfo.name, 'jev');
  const listed = await rpc(await request(worker, envelope('tools/list')));
  assertToolCatalog(listed.result.tools);
  const extracted = toolData(await call(worker, 'jev_extract', NO_MATCH));
  assert.equal(extracted.provider, 'none');
  assert.equal(extracted.summary.not_found, 1);
  assert.equal(extracted.results[0].value, null);
  assert.equal(calls.length, 0);
});

test('official Client negotiates modern MCP and preserves mixed typed results from one upstream call', async (t) => {
  const { worker, calls } = await fixture(t, {
    upstream: () => WorkerResponse.json({ model: 'actual-upstream-model', answers: ANSWERS, usage: { input_tokens: 21, output_tokens: 9 } }),
  });
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
    requestInit: { headers: { 'oai-authenticated-user-id': 'synthetic-test-user' } },
    fetch: async (input, init) => {
      const incoming = new Request(input, init);
      const response = await worker.dispatchFetch(incoming.url, {
        method: incoming.method,
        headers: Object.fromEntries(incoming.headers),
        ...(incoming.method === 'GET' || incoming.method === 'HEAD' ? {} : { body: await incoming.text() }),
      });
      return new Response(await response.arrayBuffer(), { status: response.status, headers: Object.fromEntries(response.headers) });
    },
  });
  const client = new Client({ name: 'official-worker-test-client', version: '1' }, { versionNegotiation: { mode: 'auto' } });
  t.after(() => client.close());
  await client.connect(transport);
  assert.ok(client.getDiscoverResult(), 'server/discover must succeed without a legacy fallback');
  assert.equal(transport.protocolVersion, '2026-07-28');
  const listed = await client.listTools();
  assertToolCatalog(listed.tools);
  const result = await client.callTool({ name: 'jev_evaluate', arguments: MIXED });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.deepEqual(result.structuredContent.answers, ANSWERS);
  assert.equal(result.structuredContent.model, 'actual-upstream-model');
  assert.equal(result.structuredContent.provider, 'typesafe');
  assert.deepEqual(result.structuredContent.usage, { input_tokens: 21, output_tokens: 9 });
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.authorization, `Bearer ${API_KEY}`);
  assert.deepEqual(calls[0].body, { ...MIXED, model: 'jev-test-model' });
});

test('every advertised tool completes through the production Worker and provider adapter', async (t) => {
  const { worker, calls } = await fixture(t, {
    upstream: ({ body }) => WorkerResponse.json({
      model: 'worker-sample-model', usage: { input_tokens: 42, output_tokens: 8 },
      answers: Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
        if (question.type === 'noul') {
          return [id, { type: 'noul', noul: /^(injection|check_|absence_)/.test(id) ? 0.01 : 0.99 }];
        }
        if (question.type === 'choice') {
          const keys = Object.keys(question.criteria);
          return [id, {
            type: 'choice', choice: keys[0], confidence: 1,
            probabilities: Object.fromEntries(keys.map((key, i) => [key, i === 0 ? 1 : 0])),
          }];
        }
        assert.equal(question.type, 'score');
        const score = /(?:test_gap|blast_radius)$/.test(id) ? 0 : question.criteria.length - 1;
        return [id, {
          type: 'score', score, confidence: 1,
          legend: Object.fromEntries(question.criteria.map((level, i) => [String(i), level])),
          probabilities: Object.fromEntries(question.criteria.map((_, i) => [String(i), i === score ? 1 : 0])),
        }];
      })),
    }),
  });
  const review = { request: 'Reject empty input.', diff: '+ if (!input) throw Error();', tests: 'Empty input is rejected.' };
  const perFile = {
    request: review.request, tests: review.tests,
    files: [{ path: 'input.ts', diff: review.diff }, { path: 'input.test.ts', diff: '+ assert.throws(() => parse(""));' }],
  };
  const candidates = [{ id: 'tests', text: 'The empty-input test passed.' }, { id: 'other', text: 'Release notes.' }];
  const cases = [
    ['jev_evaluate', MIXED, (data) => {
      assert.equal(data.answers.category.choice, 'refund');
      assert.equal(data.answers.quality.score, 2);
      assert.equal(data.answers.actionable.noul, 0.99);
    }],
    ['jev_verify', { claims: ['Tests passed.'], evidence: [{ id: 'none', text: 'Tests passed.' }, { id: 'notes', text: 'Other notes.' }] }, (data) => {
      assert.equal(data.results[0].verdict, 'verified');
      assert.equal(data.results[0].supporting_evidence, 'none');
    }],
    ['jev_screen', { text: 'The release is available.', purpose: 'Read release information.' }, (data) => assert.equal(data.recommendation.action, 'pass')],
    ['jev_noul', { propositions: ['Tests passed.', 'The input is validated.'], context: 'Tests passed and input is validated.' }, (data) => {
      assert.deepEqual(data.results.map((row) => row.label), ['likely', 'likely']);
    }],
    ['jev_find', { query: 'Test result', candidates }, (data) => assert.equal(data.top[0].id, 'tests')],
    ['jev_classify', {
      items: [{ id: 'charge', text: 'Charged twice.' }],
      classes: [{ id: 'billing', description: 'Payment requests' }, { id: 'technical', description: 'Technical requests' }],
    }, (data) => assert.equal(data.results[0].classification, 'billing')],
    ['jev_decide', {
      decision: 'Choose storage.', evidence: 'One writer and no network.', priorities: 'Minimal operations.',
      candidates: [{ id: 'sqlite', description: 'Embedded storage' }, { id: 'postgres', description: 'Database server' }],
      requirements: ['Works without a network.'],
    }, (data) => {
      assert.equal(data.recommendation.selected, 'sqlite');
      assert.deepEqual(data.checks.map((check) => check.answer), ['supported', 'supported']);
    }],
    ['jev_rerank', { query: 'Test result', candidates }, (data) => assert.deepEqual(data.ranked.map((row) => row.id), ['tests', 'other'])],
    ['jev_compare', { passage_a: 'Version one costs $10.', passage_b: 'Version one costs $10.', aspects: ['version', 'price'] }, (data) => {
      assert.equal(data.overall.relation, 'same_fact');
      assert.deepEqual(data.aspects.map((row) => row.relation), ['same_fact', 'same_fact']);
    }],
    ['jev_extract', { document: 'Invoice 123; total 456.', fields: [{ id: 'invoice', description: 'Invoice number', pattern: '[0-9]+' }] }, (data) => {
      assert.equal(data.results[0].value, '123');
      assert.equal(data.results[0].status, 'auto');
    }],
    ['jev_audit', { source: 'Invoice 123.', records: [{ id: 'invoice', request: 'Invoice number', value: '123' }] }, (data) => assert.equal(data.action, 'pass')],
    ['jev_review', review, (data) => assert.equal(data.action, 'auto')],
    ['jev_gate', { ...review, claims: ['Tests passed.'], evidence: 'Tests passed.' }, (data) => assert.equal(data.action, 'auto')],
    ['jev_review', perFile, (data) => {
      assert.equal(data.action, 'auto');
      assert.equal(data.mode, 'per-file');
      assert.equal(data.files.length, 2);
    }],
    ['jev_gate', { ...perFile, claims: ['Tests passed.'], evidence: 'Tests passed.' }, (data) => {
      assert.equal(data.action, 'auto');
      assert.equal(data.review.files.length, 2);
      assert.equal(data.verification.results[0].verdict, 'verified');
    }],
  ];
  assert.deepEqual([...new Set(cases.map(([name]) => name))].sort(), NAMES);
  for (const [name, args, check] of cases) {
    await t.test(`${name}${args.files ? ' per-file' : ''}`, async () => {
      const before = calls.length;
      const data = toolData(await call(worker, name, args));
      assert.equal(data.provider, 'typesafe');
      assert.equal(data.model, 'worker-sample-model');
      assert.deepEqual(data.usage, { input_tokens: 42, output_tokens: 8 });
      assert.equal(calls.length, before + 1);
      assert.equal(calls.at(-1).url, 'https://api.typesafe.ai/v1/systemone');
      assert.equal(calls.at(-1).body.model, 'jev-test-model');
      check(data);
    });
  }
});

test('Sites requests with missing routing headers support modern discovery, tools and extraction', async (t) => {
  const { worker, calls } = await fixture(t);
  for (const missing of [['Mcp-Method'], ['Mcp-Name'], ['Mcp-Method', 'Mcp-Name']]) {
    await t.test(missing.join(', '), async (t) => {
      const client = new Client({ name: 'sites-routing-test', version: '1' }, {
        versionNegotiation: { mode: { pin: '2026-07-28' } },
      });
      t.after(() => client.close());
      await client.connect(new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
        requestInit: { headers: { 'oai-authenticated-user-id': 'synthetic-test-user' } },
        fetch: async (input, init) => {
          const incoming = new Request(input, init);
          const headers = new Headers(incoming.headers);
          for (const name of missing) headers.delete(name);
          const response = await worker.dispatchFetch(incoming.url, {
            method: incoming.method,
            headers: Object.fromEntries(headers),
            ...(incoming.method === 'GET' || incoming.method === 'HEAD' ? {} : { body: await incoming.text() }),
          });
          return new Response(await response.arrayBuffer(), { status: response.status, headers: Object.fromEntries(response.headers) });
        },
      }));
      assert.ok(client.getDiscoverResult(), 'server/discover must succeed without a legacy fallback');
      assertToolCatalog((await client.listTools()).tools);
      const result = await client.callTool({ name: 'jev_extract', arguments: NO_MATCH });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      const extracted = JSON.parse(result.content[0].text);
      assert.equal(extracted.provider, 'none');
      assert.equal(extracted.summary.not_found, 1);
      assert.equal(extracted.results[0].value, null);
    });
  }
  assert.equal(calls.length, 0);
});

test('Sites routing compatibility preserves header mismatch and authentication checks', async (t) => {
  const { worker, calls } = await fixture(t);
  const body = envelope('tools/call', {
    name: 'jev_extract', arguments: NO_MATCH,
    _meta: { [PROTOCOL_VERSION_META_KEY]: '2026-07-28', [CLIENT_CAPABILITIES_META_KEY]: {} },
  });
  for (const mismatch of [
    { 'Mcp-Method': 'tools/list' },
    { 'Mcp-Name': 'another_tool' },
    { 'MCP-Protocol-Version': VERSION },
  ]) {
    const response = await request(worker, body, { headers: { 'MCP-Protocol-Version': '2026-07-28', ...mismatch } });
    assert.equal(response.status, 400, JSON.stringify(mismatch));
    assert.equal((await response.json()).error.code, -32020);
  }
  assert.equal((await request(worker, body, { authenticated: false })).status, 401);
  assert.equal((await request(worker, body, { headers: { Origin: 'https://other.example' } })).status, 403);
  assert.equal(calls.length, 0);
});

test('Sites identity is required and requests without Origin or with the same Origin are accepted', async (t) => {
  const { worker, calls } = await fixture(t);
  for (const options of [{ authenticated: false }, { headers: { 'oai-authenticated-user-id': '   ' } }]) {
    const response = await request(worker, envelope('tools/list'), options);
    assert.equal(response.status, 401);
  }
  const crossOrigin = await request(worker, envelope('tools/list'), { headers: { Origin: 'https://other.example' } });
  assert.equal(crossOrigin.status, 403);
  for (const headers of [{}, { Origin: ORIGIN }]) {
    const listed = await rpc(await request(worker, envelope('tools/list'), { headers }));
    assert.equal(listed.result.tools.length, 13);
  }
  assert.equal(calls.length, 0);
});

test('health is public and an unconfigured Worker refuses tool traffic', async (t) => {
  const { worker, calls } = await fixture(t, { configured: false });
  for (const path of ['/', '/health']) {
    const response = await request(worker, undefined, { path, method: 'GET', authenticated: false });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { name: 'jev', status: 'ok', configured: false });
  }
  const response = await request(worker, envelope('tools/list'));
  assert.equal(response.status, 503);
  assert.equal(calls.length, 0);
});

test('HTTP method, media type, request size and JSON envelope checks run before tool handling', async (t) => {
  const { worker, calls } = await fixture(t);
  const cases = [
    [envelope('tools/list'), { method: 'GET' }, 405],
    [envelope('tools/list'), { headers: { 'Content-Type': 'text/plain' } }, 415],
    ['{ invalid json', {}, 400],
    ['{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"__proto__":{"polluted":true}}}', {}, 400],
    [' '.repeat(2 * 1024 * 1024 + 1), {}, 413],
    [envelope('tools/list'), { path: '/missing' }, 404],
  ];
  for (const [body, options, status] of cases) {
    const response = await request(worker, body, options);
    assert.equal(response.status, status, await response.text());
    assert.equal(response.headers.get('cache-control'), 'no-store');
    if (status === 405) assert.equal(response.headers.get('allow'), 'POST');
  }
  assert.equal(calls.length, 0);
});

test('strict generic tool inputs fail before any upstream call', async (t) => {
  const { worker, calls } = await fixture(t);
  const cases = [
    { ...MIXED, model: 'caller-controlled-model' },
    { state: {}, questions: { p: { type: 'unknown' } } },
    { state: {}, questions: {} },
    { state: {}, questions: { p: { type: 'choice', criteria: { only: 'One option' } } } },
    { state: {}, questions: { p: { type: 'noul', extra: true } } },
    { state: 'x'.repeat(128 * 1024), questions: { p: { type: 'noul' } } },
  ];
  for (const args of cases) {
    const reply = await call(worker, 'jev_evaluate', args);
    assert.ok(reply.result?.isError || reply.error?.code === -32602, JSON.stringify(reply));
  }
  assert.equal(calls.length, 0);
});

test('upstream redirects and HTTP errors are sanitized without following or retrying', async (t) => {
  let status = 302;
  const { worker, calls } = await fixture(t, {
    upstream: () => new WorkerResponse(`secret-upstream-body ${API_KEY}`, {
      status, headers: { Location: 'https://must-not-follow.invalid/private' },
    }),
  });
  for (const upstreamStatus of [302, 429, 503]) {
    status = upstreamStatus;
    const before = calls.length;
    const reply = await call(worker, 'jev_evaluate', MIXED);
    assert.equal(reply.result.isError, true);
    assert.equal(reply.result.content[0].text, 'Jev evaluation failed.');
    assert.equal(calls.length, before + 1);
    assert.doesNotMatch(JSON.stringify(reply), /secret-upstream-body|synthetic-worker-test-key/);
  }
});

test('malformed typed upstream output becomes a tool error without disclosing response data', async (t) => {
  const { worker, calls } = await fixture(t, {
    upstream: () => WorkerResponse.json({
      model: 'test-model',
      answers: { ...ANSWERS, actionable: { type: 'noul', noul: 7, private: 'upstream-private-data' } },
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  });
  const reply = await call(worker, 'jev_evaluate', MIXED);
  assert.equal(reply.result.isError, true);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(JSON.stringify(reply), /upstream-private-data/);
});
