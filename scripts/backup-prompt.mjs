// Terminal and piped input for the backup scripts. Secrets are never echoed or placed in arguments, the environment or files.
// JavaScript strings cannot be zeroized; callers drop their references as soon as a value has been used.

export class PromptError extends Error {
  constructor(problem) { super(`Input ${problem}.`); this.name = 'PromptError'; this.problem = problem; }
}

// Reads all of a piped stream, refusing more than `limit` bytes.
export async function readPipedInput(stream, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw new PromptError('tooLong');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

// Terminal escape sequences (arrow keys and the like) are dropped rather than taken as input.
// eslint-disable-next-line no-control-regex
const escapeSequence = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|O.|.)?/g;

// Reads one line from a terminal in raw mode. Hidden input is never echoed; visible input echoes printable characters only.
// Enter finishes, Ctrl+C and Ctrl+D cancel, Backspace deletes. The terminal mode and listeners are restored on every path.
export function readTerminalLine({ input, output, prompt, hidden, limit, overflow = 'error' }) {
  output.write(prompt);
  return new Promise((done, failed) => {
    let value = '';
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('error', onError);
      try { input.setRawMode(false); } catch { /* the stream may already be closed */ }
      input.pause();
      output.write('\n');
      if (error) failed(error); else done(value);
      value = '';
    };
    const onEnd = () => finish(new PromptError('cancelled'));
    const onError = () => finish(new PromptError('cancelled'));
    const onData = (text) => {
      for (const character of String(text).replace(escapeSequence, '')) {
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u0003' || character === '\u0004') return finish(new PromptError('cancelled'));
        if (character === '\u007f' || character === '\b') {
          if (value) { value = [...value].slice(0, -1).join(''); if (!hidden) output.write('\b \b'); }
          continue;
        }
        if (character < ' ') continue;
        if ([...value].length >= limit) {
          if (overflow === 'error') return finish(new PromptError('tooLong'));
          continue;
        }
        value += character;
        if (!hidden) output.write(character);
      }
    };
    try {
      input.setRawMode(true);
      input.setEncoding('utf8');
      input.on('data', onData);
      input.once('end', onEnd);
      input.once('error', onError);
      input.resume();
    } catch {
      finish(new PromptError('cancelled'));
    }
  });
}
