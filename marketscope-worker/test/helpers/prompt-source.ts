// The prompt-building SOURCE, as one string.
//
// A handful of assertions are genuinely about source rather than behaviour: that a removed rule
// left no dead code behind, and that a specific piece of prompt WORDING is present or absent. Those
// are worth keeping — but they were reading `src/prompt.ts` alone, and on 2026-08-26 the Conviction
// Envelope moved to `src/envelope.ts`. A negative assertion (`expect(src).not.toMatch(...)`) does
// not fail when its subject moves to another file: it silently starts passing for the wrong reason,
// which is precisely the vacuous-green failure mode the Phase 0.4 conversion was written to end.
//
// So source assertions read BOTH files. Add a file here whenever prompt construction gains one.
import { readFileSync } from 'fs';
import { join } from 'path';

const FILES = ['prompt.ts', 'envelope.ts'];

export const promptSource: string =
  FILES.map(f => readFileSync(join(__dirname, '..', '..', 'src', f), 'utf-8')).join('\n');
