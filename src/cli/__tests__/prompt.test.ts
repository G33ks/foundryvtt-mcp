/**
 * @fileoverview Tests for the terminal requirement of `init`.
 */

import { describe, expect, it } from 'vitest';
import { terminalProblem } from '../prompt.js';

describe('terminalProblem', () => {
  it('accepts an interactive terminal', () => {
    expect(terminalProblem({ isTTY: true }, { isTTY: true })).toBeNull();
  });

  it('refuses redirected input or output, pointing at init --check', () => {
    for (const [stdin, stdout] of [
      [{ isTTY: false }, { isTTY: true }],
      [{}, { isTTY: true }],
      [{ isTTY: true }, { isTTY: undefined }],
    ]) {
      const problem = terminalProblem(stdin, stdout);
      expect(problem).toMatch(/needs an interactive terminal/);
      expect(problem).toContain('init --check');
    }
  });

  it('names the command to run, as given', () => {
    const command = 'node "C:\\x\\dist\\index.js"';
    const problem = terminalProblem({ isTTY: false }, { isTTY: true }, command);
    expect(problem).toContain(`\`winpty ${command} init\``);
    expect(problem).toContain(`\`${command} init --check\``);
  });
});
