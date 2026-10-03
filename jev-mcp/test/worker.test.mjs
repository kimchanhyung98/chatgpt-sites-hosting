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

test('production Worker negotiates legacy MCP, lists 13 tools and extracts without outbound calls', async (t) => {
  const { worker, calls } = await fixture(t);
  const initialized = await rpc(await request(worker, envelope('initialize', {
    protocolVersion: VERSION, capabilities: {}, clientInfo: { name: 'worker-tests', version: '1' },
  })));
  assert.equal(initialized.result.protocolVersion, VERSION);
  assert.equal(initialized.result.serverInfo.name, 'jev');
  const listed = await rpc(await request(worker, envelope('tools/list')));
  assert.deepEqual(listed.result.tools.map((tool) => tool.name).sort(), NAMES);
  for (const tool of listed.result.tools) {
    assert.deepEqual(tool.annotations, {
      readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    }, tool.name);
  }
  assert.ok(listed.result.tools.find((tool) => tool.name === 'jev_evaluate').outputSchema);
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
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), NAMES);
  for (const tool of listed.tools) {
    assert.deepEqual(tool.annotations, {
      readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true,
    }, tool.name);
  }
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
      assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), NAMES);
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
