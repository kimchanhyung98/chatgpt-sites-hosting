import { RE2JS } from 're2js';
import type { JevRuntime } from '../application/ports.js';
import {
  MAX_EXTRACT_CANDIDATES as MAX_CANDIDATES,
  MAX_EXTRACT_CANDIDATE_CHARS as MAX_CANDIDATE_CHARS,
} from '../domain/policies.js';

export const MAX_REGEX_PATTERN_CHARS = 500;
export const MAX_REGEX_DOCUMENT_CHARS = 50_000;
export const MAX_REGEX_PROGRAM_SIZE = 4_096;
export const REGEX_WORK_BUDGET = 5_000_000;

type CostFrame = { sum: number; last: number };

// Overestimate compiled instructions before counted repeats can allocate a large program.
// RE2JS still performs the final syntax check; this scanner is deliberately conservative.
export function estimateProgramSize(pattern: string): number {
  const stack: CostFrame[] = [{ sum: 0, last: 0 }];
  const current = (): CostFrame => stack[stack.length - 1]!;
  const check = (): void => {
    if (current().sum + 2 > MAX_REGEX_PROGRAM_SIZE) {
      throw new Error(`regex estimated program exceeds ${MAX_REGEX_PROGRAM_SIZE} instructions; simplify the pattern`);
    }
  };
  const atom = (cost: number): void => {
    const frame = current();
    frame.sum += cost;
    frame.last = cost;
    check();
  };
  const repeat = (cost: number): void => {
    const frame = current();
    if (!frame.last) throw new Error('regex repetition has no preceding atom');
    frame.sum += cost - frame.last;
    frame.last = cost;
    check();
  };

  for (let i = 0; i < pattern.length;) {
    const character = pattern[i];
    if (character === '\\') {
      if (pattern[i + 1] === 'Q') {
        i += 2;
        while (i < pattern.length && !pattern.startsWith('\\E', i)) {
          atom(1);
          i += 1;
        }
        if (pattern.startsWith('\\E', i)) i += 2;
        continue;
      }
      if (['p', 'P', 'x'].includes(pattern[i + 1] ?? '') && pattern[i + 2] === '{') {
        const end = pattern.indexOf('}', i + 3);
        if (end === -1) throw new Error('unclosed regex escape');
        i = end + 1;
      } else if (pattern[i + 1] === 'x') {
        i += 4;
      } else if (/[0-7]/.test(pattern[i + 1] ?? '')) {
        i += 2;
        for (let digits = 1; digits < 3 && /[0-7]/.test(pattern[i] ?? ''); digits += 1) i += 1;
      } else {
        i += 2;
      }
      atom(1);
      continue;
    }
    if (character === '[') {
      i += 1;
      if (pattern[i] === '^') i += 1;
      if (pattern[i] === ']') i += 1;
      let closed = false;
      while (i < pattern.length) {
        if (pattern[i] === '\\') {
          i += 2;
          continue;
        }
        if (pattern.startsWith('[:', i)) {
          const end = pattern.indexOf(':]', i + 2);
          if (end === -1) throw new Error('unclosed POSIX character class');
          i = end + 2;
          continue;
        }
        if (pattern[i] === ']') {
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) throw new Error('unclosed regex character class');
      atom(1);
      continue;
    }
    if (character === '(') {
      if (pattern[i + 1] === '?') {
        if (pattern.startsWith('(?:', i)) {
          i += 3;
        } else if (pattern.startsWith('(?P<', i) || pattern.startsWith('(?<', i)) {
          if (['=', '!'].includes(pattern[i + 3] ?? '')) throw new Error('lookbehind is unsupported');
          const end = pattern.indexOf('>', i + 3);
          if (end === -1) throw new Error('unclosed regex named capture');
          i = end + 1;
        } else {
          const flag = /^\(\?[imsU-]+([:)])/.exec(pattern.slice(i));
          if (!flag) throw new Error('regex group extension is unsupported');
          i += flag[0].length;
          if (flag[1] === ')') continue;
        }
      } else {
        i += 1;
      }
      stack.push({ sum: 0, last: 0 });
      continue;
    }
    if (character === ')') {
      if (stack.length === 1) throw new Error('unmatched regex closing group');
      const group = stack.pop()!;
      atom(Math.max(1, group.sum) + 2);
      i += 1;
      continue;
    }
    if (character === '|') {
      current().sum += 2;
      current().last = 0;
      check();
      i += 1;
      continue;
    }
    if (character === '*' || character === '+' || character === '?') {
      repeat(current().last + 2);
      i += 1;
      continue;
    }
    if (character === '{') {
      const count = /^\{(0|[1-9][0-9]*)(?:,((?:0|[1-9][0-9]*)?))?\}/.exec(pattern.slice(i));
      if (count) {
        const minimum = Number(count[1]);
        const open = count[2] === '';
        const maximum = count[2] === undefined || open ? minimum : Number(count[2]);
        if (minimum > 1_000 || maximum > 1_000 || minimum > maximum) {
          throw new Error('regex repeat count must be at most 1000, with minimum at most maximum');
        }
        const cost = open
          ? Math.max(1, minimum) * current().last + 2
          : Math.max(1, maximum * current().last + maximum - minimum);
        repeat(cost);
        i += count[0].length;
        continue;
      }
    }
    atom(1);
    i += 1;
  }
  if (stack.length !== 1) throw new Error('unclosed regex group');
  return Math.max(1, current().sum) + 2;
}

// Create once per MCP request so every field shares the same work allowance.
export function createRegexRunner(): JevRuntime['runRegex'] {
  let remaining = REGEX_WORK_BUDGET;
  return async (document, pattern, flags, signal) => {
    try {
      if (signal?.aborted) throw new Error('request aborted');
      if (document.length > MAX_REGEX_DOCUMENT_CHARS) {
        throw new Error(`regex document exceeds ${MAX_REGEX_DOCUMENT_CHARS} UTF-16 code units`);
      }
      if (pattern.length < 1 || pattern.length > MAX_REGEX_PATTERN_CHARS) {
        throw new Error(`regex pattern must contain 1–${MAX_REGEX_PATTERN_CHARS} UTF-16 code units`);
      }
      if (flags.length > 8 || /[^gimsu]/.test(flags)) {
        throw new Error('supported regex flags: g, i, m, s, u; Unicode matching is always enabled');
      }
      const nonGlobalFlags = flags.replace(/g/g, '');
      if (new Set(nonGlobalFlags).size !== nonGlobalFlags.length) throw new Error('duplicate regex flags');
      estimateProgramSize(pattern);
      let options = 0;
      if (flags.includes('i')) options |= RE2JS.CASE_INSENSITIVE;
      if (flags.includes('m')) options |= RE2JS.MULTILINE;
      if (flags.includes('s')) options |= RE2JS.DOTALL;
      const regex = RE2JS.compile(pattern, options);
      const programSize = regex.programSize();
      if (programSize > MAX_REGEX_PROGRAM_SIZE) {
        throw new Error(`regex program exceeds ${MAX_REGEX_PROGRAM_SIZE} instructions; simplify the pattern`);
      }
      const matcher = regex.matcher(document);
      const seen = new Set<string>();
      const candidates: string[] = [];
      let truncated = false;
      let tooLong = 0;
      let start = 0;
      while (true) {
        if (signal?.aborted) throw new Error('request aborted');
        // Each search can inspect the entire remaining suffix even after a short match.
        const work = programSize * Math.max(1, document.length - start + 1)
          + Math.ceil(programSize * (document.length + 1) / 32);
        if (work > remaining) {
          throw new Error('regex request work budget exceeded; simplify patterns or split the document');
        }
        remaining -= work;
        if (!matcher.find()) break;
        start = matcher.end();
        if (matcher.start() === start) start += 1;
        const value = matcher.group(0);
        if (value === null) throw new Error('regex returned an invalid whole match');
        if (value.length === 0 || seen.has(value)) continue;
        seen.add(value);
        if (value.length > MAX_CANDIDATE_CHARS) {
          tooLong += 1;
          continue;
        }
        if (candidates.length >= MAX_CANDIDATES) {
          truncated = true;
          break;
        }
        candidates.push(value);
      }
      return { candidates, truncated, tooLong, error: null };
    } catch (error) {
      return {
        candidates: [],
        truncated: false,
        tooLong: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}
