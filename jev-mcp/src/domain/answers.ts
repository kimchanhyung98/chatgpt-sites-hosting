import { isRecord as record, PROBABILITY_SUM_TOLERANCE } from './policies.js';

export interface ValidatedEvaluation {
  model: string;
  answers: Record<string, unknown>;
  usage: { input_tokens: number; output_tokens: number };
}

function invalid(): never {
  throw new Error('Invalid TypeSafe response.');
}

function entry(value: unknown): boolean {
  return typeof value === 'string' || Array.isArray(value) || record(value);
}

function sameKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function probability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function distribution(value: unknown, keys: string[]): void {
  if (!record(value) || !sameKeys(value, keys)) invalid();
  let sum = 0;
  for (const key of keys) {
    const amount = value[key];
    if (!probability(amount)) invalid();
    sum += amount;
  }
  if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) invalid();
}

export function validateEvaluationEnvelope(value: unknown): ValidatedEvaluation {
  if (!record(value) || typeof value.model !== 'string' || value.model.length < 1 || value.model.length > 256) invalid();
  const answers = value.answers;
  if (!record(answers)) invalid();
  const usage = value.usage;
  if (!record(usage)) invalid();
  for (const key of ['input_tokens', 'output_tokens']) {
    if (!Number.isSafeInteger(usage[key]) || (usage[key] as number) < 0) invalid();
  }
  return {
    model: value.model,
    answers,
    usage: { input_tokens: usage.input_tokens as number, output_tokens: usage.output_tokens as number },
  };
}

export function validateAnswers(
  questions: Record<string, unknown>,
  value: unknown,
): ValidatedEvaluation {
  const envelope = validateEvaluationEnvelope(value);
  const answers = envelope.answers;
  const keys = Object.keys(questions);
  if (keys.length === 0 || !sameKeys(answers, keys)) invalid();

  for (const id of keys) {
    const question = questions[id];
    const answer = answers[id];
    if (!record(question) || !record(answer) || answer.type !== question.type) invalid();
    if (question.type === 'noul') {
      if (!probability(answer.noul)) invalid();
      continue;
    }
    if (!probability(answer.confidence)) invalid();
    if (question.type === 'choice') {
      if (!record(question.criteria)) invalid();
      const options = Object.keys(question.criteria);
      if (options.length === 0 || typeof answer.choice !== 'string' || !Object.hasOwn(question.criteria, answer.choice)) invalid();
      distribution(answer.probabilities, options);
    } else if (question.type === 'score') {
      if (!Array.isArray(question.criteria) || question.criteria.length === 0) invalid();
      const levels = question.criteria.map((_, index) => String(index));
      if (typeof answer.score !== 'number' || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > levels.length - 1) invalid();
      if (!record(answer.legend) || !sameKeys(answer.legend, levels) || !Object.values(answer.legend).every(entry)) invalid();
      distribution(answer.probabilities, levels);
    } else {
      invalid();
    }
  }

  return envelope;
}
