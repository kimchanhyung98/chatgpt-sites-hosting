import { isRecord as record, PROBABILITY_SUM_TOLERANCE, SCORE_MEAN_TOLERANCE } from './policies.js';

export interface ValidatedEvaluation {
  model: string;
  answers: Record<string, unknown>;
  usage: { input_tokens: number; output_tokens: number };
}

function invalid(): never {
  throw new Error('Invalid TypeSafe response.');
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => sameJson(value, right[index]));
  }
  if (record(left) && record(right)) {
    return sameKeys(right, Object.keys(left)) && Object.keys(left).every((key) => sameJson(left[key], right[key]));
  }
  return false;
}

function sameKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function probability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function distribution(value: unknown, keys: string[]): Record<string, number> {
  if (!record(value) || !sameKeys(value, keys)) invalid();
  let sum = 0;
  for (const key of keys) {
    const amount = value[key];
    if (!probability(amount)) invalid();
    sum += amount;
  }
  if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) invalid();
  return value as Record<string, number>;
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
      const probabilities = distribution(answer.probabilities, options);
      if (probabilities[answer.choice]! < Math.max(...Object.values(probabilities)) - 1e-9) invalid();
    } else if (question.type === 'score') {
      if (!Array.isArray(question.criteria) || question.criteria.length === 0) invalid();
      const levels = question.criteria.map((_, index) => String(index));
      if (typeof answer.score !== 'number' || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > levels.length - 1) invalid();
      const legend = answer.legend;
      if (!record(legend) || !sameKeys(legend, levels) || !question.criteria.every((level, index) => sameJson(level, legend[String(index)]))) invalid();
      const probabilities = distribution(answer.probabilities, levels);
      const mean = levels.reduce((sum, level) => sum + Number(level) * probabilities[level]!, 0);
      // Extend the three-level policy's two-decimal rounding allowance to larger rubrics.
      const roundingTolerance = 0.005 * (1 + levels.length * (levels.length - 1) / 2) + 1e-12;
      if (Math.abs(mean - answer.score) > Math.max(SCORE_MEAN_TOLERANCE, roundingTolerance)) invalid();
    } else {
      invalid();
    }
  }

  return envelope;
}
