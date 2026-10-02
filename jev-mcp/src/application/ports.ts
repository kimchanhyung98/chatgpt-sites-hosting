export interface AskResult {
  answers: Record<string, any>;
  usage: { input_tokens: number; output_tokens: number };
  provider: "typesafe";
  model: string;
}

export interface RegexResult {
  candidates: string[];
  truncated: boolean;
  tooLong: number;
  error: string | null;
}

export interface JevRuntime {
  model: string;
  ask: (state: unknown, questions: Record<string, unknown>, model: string, signal?: AbortSignal) => Promise<AskResult>;
  runRegex: (document: string, pattern: string, flags: string, signal?: AbortSignal) => Promise<RegexResult>;
}
