/**
 * @fileoverview Terminal questions for `init`.
 *
 * Every answer is read in raw mode, key by key, so that a password is never
 * echoed: no character, no mask, nothing that shows its length. Works in
 * PowerShell, Windows Terminal and cmd (Node's console handling under
 * ConPTY) as in POSIX terminals; Git Bash's mintty without winpty is no
 * terminal for Node, and is refused like a redirected input.
 */

import { emitKeypressEvents } from 'node:readline';

/** The user pressed Ctrl+C (or Ctrl+D on an empty answer). */
export class PromptCancelled extends Error {
  override name = 'PromptCancelled';

  constructor() {
    super('Cancelled.');
  }
}

export interface Prompter {
  /** A line of text; Enter alone gives `defaultValue` (or ''). */
  ask(question: string, defaultValue?: string): Promise<string>;
  /**
   * A secret, never echoed. With `keepable`, Enter alone keeps the current
   * value and resolves `null`.
   */
  askSecret(question: string, keepable: boolean): Promise<string | null>;
  /** Yes or no; Enter alone gives `defaultValue`. */
  confirm(question: string, defaultValue: boolean): Promise<boolean>;
  /** Waits for Enter. */
  pause(message: string): Promise<void>;
}

/** Why `init` cannot ask anything here, or `null` when it can. */
export function terminalProblem(
  stdin: { isTTY?: boolean } = process.stdin,
  stdout: { isTTY?: boolean } = process.stdout,
  command = 'node dist/index.js',
): string | null {
  if (stdin.isTTY && stdout.isTTY) {
    return null;
  }
  return [
    '`init` asks questions and needs an interactive terminal, but its input or output is redirected.',
    `Run it directly in PowerShell, Windows Terminal, cmd or a terminal window (in Git Bash: \`winpty ${command} init\`).`,
    `To check an existing configuration without questions, run \`${command} init --check\`.`,
  ].join('\n');
}

interface KeyInfo {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  sequence?: string;
}

function hasControlCharacter(text: string): boolean {
  return Array.from(text).some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
}

/** Reads one answer in raw mode; `echo` false shows nothing at all. */
function readAnswer(prompt: string, echo: boolean): Promise<string> {
  const { stdin, stdout } = process;
  return new Promise((resolve, reject) => {
    let answer = '';
    emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdout.write(prompt);

    const done = (outcome: () => void) => {
      stdin.off('keypress', onKey);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdout.write('\n');
      outcome();
    };
    const onKey = (text: string | undefined, key: KeyInfo | undefined) => {
      if (key?.ctrl && (key.name === 'c' || (key.name === 'd' && answer === ''))) {
        done(() => reject(new PromptCancelled()));
        return;
      }
      if (key?.name === 'return' || key?.name === 'enter') {
        done(() => resolve(answer));
        return;
      }
      if (key?.name === 'backspace') {
        if (answer.length > 0) {
          const chars = Array.from(answer);
          chars.pop();
          answer = chars.join('');
          if (echo) {
            stdout.write('\b \b');
          }
        }
        return;
      }
      // Arrows, function keys and other control sequences carry no text.
      if (key?.ctrl || key?.meta || text === undefined || hasControlCharacter(text)) {
        return;
      }
      answer += text;
      if (echo) {
        stdout.write(text);
      }
    };
    stdin.on('keypress', onKey);
  });
}

/** The prompter for an interactive terminal. */
export function terminalPrompter(): Prompter {
  return {
    async ask(question, defaultValue) {
      const hint = defaultValue ? ` [${defaultValue}]` : '';
      const answer = (await readAnswer(`${question}${hint}: `, true)).trim();
      return answer === '' ? (defaultValue ?? '') : answer;
    },
    async askSecret(question, keepable) {
      const hint = keepable ? ' [<set> — Enter keeps it]' : '';
      const answer = await readAnswer(`${question}${hint} (typing stays hidden): `, false);
      return answer === '' && keepable ? null : answer;
    },
    async confirm(question, defaultValue) {
      const hint = defaultValue ? '[Y/n]' : '[y/N]';
      for (;;) {
        const answer = (await readAnswer(`${question} ${hint} `, true)).trim().toLowerCase();
        if (answer === '') {
          return defaultValue;
        }
        if (['y', 'yes', 'o', 'oui'].includes(answer)) {
          return true;
        }
        if (['n', 'no', 'non'].includes(answer)) {
          return false;
        }
      }
    },
    async pause(message) {
      await readAnswer(`${message} `, true);
    },
  };
}
