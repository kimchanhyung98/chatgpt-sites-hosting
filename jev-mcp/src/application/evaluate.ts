import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { validateAnswers } from '../domain/answers.js';
import type { JevRuntime } from './ports.js';

const MAX_INPUT_BYTES = 128 * 1024;
const MAX_JSON_DEPTH = 32;
const key = z.string().min(1).max(128);
const entry = z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]);
const nullableEntry = entry.nullable();
const instructions = nullableEntry.optional().describe('One complete judgment; question IDs do not provide instructions to the model.');
const question = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('noul'),
    instructions,
    criteria: z.strictObject({ true: nullableEntry.optional(), false: nullableEntry.optional() }).nullable().optional(),
  }),
  z.strictObject({
    type: z.literal('choice'),
    instructions,
    criteria: z.record(key, nullableEntry).refine((value) => Object.keys(value).length >= 2 && Object.keys(value).length <= 255, 'Provide 2 to 255 choice options.'),
  }),
  z.strictObject({
    type: z.literal('score'),
    instructions,
    criteria: z.array(entry).min(2).max(10),
  }),
]);

function boundedJson(value: unknown, depth = 0, ancestors = new Set<object>()): boolean {
  if (depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  ancestors.add(value);
  const valid = Object.values(value).every((child) => boundedJson(child, depth + 1, ancestors));
  ancestors.delete(value);
  return valid;
}

export const evaluateInputSchema = z.strictObject({
  state: entry.describe('Observed evidence and relevant context as text or JSON. Send only material needed by the questions.'),
  questions: z.record(key, question).refine((value) => Object.keys(value).length >= 1 && Object.keys(value).length <= 32, 'Provide 1 to 32 questions.'),
}).superRefine((value, context) => {
  if (!boundedJson(value)) {
    context.addIssue({ code: 'custom', message: 'Provide finite JSON values nested no more than 32 levels.' });
    return;
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_INPUT_BYTES) {
    context.addIssue({ code: 'custom', message: 'Evaluation input must not exceed 128 KiB of JSON.' });
  }
});

const probability = z.number().min(0).max(1);
const outputAnswer = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('noul'), noul: probability }),
  z.looseObject({ type: z.literal('choice'), choice: z.string(), confidence: probability, probabilities: z.record(z.string(), probability) }),
  z.looseObject({ type: z.literal('score'), score: z.number(), confidence: probability, legend: z.record(z.string(), entry), probabilities: z.record(z.string(), probability) }),
]);

export function registerEvaluateTool(server: McpServer, runtime: JevRuntime): void {
  server.registerTool('jev_evaluate', {
    title: 'Evaluate typed questions with Jev',
    description: 'Evaluate 1 to 32 independent questions against one shared state in one TypeSafe request. Mix noul (P(yes)), choice (one of 2 to 255 options), and score (a weighted position on 2 to 10 ordered levels, indexed from zero). Returns the original probabilities, confidence, rubric, model and token usage. Noul has no separate confidence; Choice/Score confidence describes distribution concentration, not correctness or permission to act. Use code for counting, arithmetic and policy. Maximum input is 128 KiB of JSON with nesting depth 32. The server controls the model.',
    inputSchema: evaluateInputSchema,
    outputSchema: z.strictObject({
      provider: z.literal('typesafe'),
      model: z.string(),
      answers: z.record(z.string(), outputAnswer),
      usage: z.strictObject({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ state, questions }, context) => {
    try {
      const signal = context.mcpReq.signal;
      signal.throwIfAborted();
      const result = await runtime.ask(state, questions, runtime.model, signal);
      signal.throwIfAborted();
      if (result.provider !== 'typesafe') throw new Error('Invalid TypeSafe response.');
      const output = { ...validateAnswers(questions, result), provider: 'typesafe' as const };
      return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
    } catch {
      return { isError: true, content: [{ type: 'text', text: 'Jev evaluation failed.' }] };
    }
  });
}
