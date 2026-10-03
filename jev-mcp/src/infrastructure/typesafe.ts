import type { AskResult, JevRuntime } from '../application/ports.js';
import { validateEvaluationEnvelope } from '../domain/answers.js';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const REQUEST_LIMIT = 2 * 1024 * 1024;
const RESPONSE_LIMIT = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 45_000;

const ERROR_MESSAGES = {
  TYPESAFE_ABORTED: 'TypeSafe request was cancelled.',
  TYPESAFE_TIMEOUT: 'TypeSafe request timed out.',
  TYPESAFE_REQUEST_TOO_LARGE: 'TypeSafe request exceeds the size limit.',
  TYPESAFE_RESPONSE_TOO_LARGE: 'TypeSafe response exceeds the size limit.',
  TYPESAFE_INVALID_RESPONSE: 'TypeSafe returned an invalid response.',
  TYPESAFE_HTTP_ERROR: 'TypeSafe returned an unsuccessful HTTP status.',
  TYPESAFE_NETWORK_ERROR: 'TypeSafe request could not be completed.',
  TYPESAFE_INVALID_REQUEST: 'TypeSafe request could not be encoded.',
  TYPESAFE_CONFIGURATION_ERROR: 'TypeSafe configuration is invalid.',
} as const;

type TypeSafeErrorCode = keyof typeof ERROR_MESSAGES;

export class TypeSafeError extends Error {
  readonly code: TypeSafeErrorCode;
  readonly status?: number;

  constructor(code: TypeSafeErrorCode, status?: number) {
    super(ERROR_MESSAGES[code]);
    this.name = 'TypeSafeError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

export function createTypeSafeEvaluator(config: {
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): JevRuntime['ask'] {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    typeof config.apiKey !== 'string' ||
    !config.apiKey.trim() ||
    /[\r\n]/.test(config.apiKey) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 2_147_483_647
  ) {
    throw new TypeSafeError('TYPESAFE_CONFIGURATION_ERROR');
  }

  const fetchRequest = config.fetch ?? fetch;
  const apiKey = config.apiKey;

  return async (state, questions, model, signal): Promise<AskResult> => {
    if (signal?.aborted) throw new TypeSafeError('TYPESAFE_ABORTED');

    let body: Uint8Array<ArrayBuffer>;
    try {
      body = new TextEncoder().encode(JSON.stringify({ state, questions, model }));
    } catch {
      throw new TypeSafeError('TYPESAFE_INVALID_REQUEST');
    }
    if (body.byteLength > REQUEST_LIMIT) {
      throw new TypeSafeError('TYPESAFE_REQUEST_TOO_LARGE');
    }

    const controller = new AbortController();
    let abortCode: 'TYPESAFE_ABORTED' | 'TYPESAFE_TIMEOUT' = 'TYPESAFE_ABORTED';
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    const cancelBody = (): void => {
      try {
        const cancellation = reader ? reader.cancel() : response?.body?.cancel();
        void cancellation?.catch(() => undefined);
      } catch {
        // Cancellation must not replace the sanitized request error.
      }
    };

    let rejectAbort!: (reason: TypeSafeError) => void;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const onAbort = (): void => {
      cancelBody();
      rejectAbort(new TypeSafeError(abortCode));
    };
    const onRequestAbort = (): void => {
      abortCode = 'TYPESAFE_ABORTED';
      controller.abort();
    };
    controller.signal.addEventListener('abort', onAbort, { once: true });
    signal?.addEventListener('abort', onRequestAbort, { once: true });
    const timer = setTimeout(() => {
      abortCode = 'TYPESAFE_TIMEOUT';
      controller.abort();
    }, timeoutMs);

    const execute = async (): Promise<AskResult> => {
      try {
        if (signal?.aborted) onRequestAbort();
        if (controller.signal.aborted) throw new TypeSafeError(abortCode);

        response = await fetchRequest(ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body,
          redirect: 'manual',
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          cancelBody();
          throw new TypeSafeError(abortCode);
        }
        if (!response.ok) {
          cancelBody();
          throw new TypeSafeError('TYPESAFE_HTTP_ERROR', response.status);
        }

        const length = response.headers.get('Content-Length');
        if (length !== null && /^\d+$/.test(length) && Number(length) > RESPONSE_LIMIT) {
          cancelBody();
          throw new TypeSafeError('TYPESAFE_RESPONSE_TOO_LARGE');
        }
        if (response.body === null) throw new TypeSafeError('TYPESAFE_INVALID_RESPONSE');

        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        for (;;) {
          const next = await reader.read();
          if (controller.signal.aborted) throw new TypeSafeError(abortCode);
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > RESPONSE_LIMIT) {
            cancelBody();
            throw new TypeSafeError('TYPESAFE_RESPONSE_TOO_LARGE');
          }
          chunks.push(next.value);
        }

        try {
          const buffer = new Uint8Array(bytes);
          let offset = 0;
          for (const chunk of chunks) {
            buffer.set(chunk, offset);
            offset += chunk.byteLength;
          }
          const decoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
          const validated = validateEvaluationEnvelope(JSON.parse(decoded));
          return { ...validated, provider: 'typesafe' };
        } catch {
          throw new TypeSafeError('TYPESAFE_INVALID_RESPONSE');
        }
      } catch (error) {
        if (controller.signal.aborted) throw new TypeSafeError(abortCode);
        if (error instanceof TypeSafeError) throw error;
        throw new TypeSafeError('TYPESAFE_NETWORK_ERROR');
      } finally {
        reader?.releaseLock();
        reader = undefined;
      }
    };

    try {
      return await Promise.race([execute(), aborted]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onRequestAbort);
      controller.signal.removeEventListener('abort', onAbort);
    }
  };
}
