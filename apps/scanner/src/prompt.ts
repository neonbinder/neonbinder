import { createInterface } from "node:readline/promises";

/** The answer when the person asked to leave rather than typing a line. */
export const QUIT = Symbol("quit");
export type Answer = string | undefined | typeof QUIT;

/**
 * One line from the keyboard. Undefined when there is no keyboard (piped).
 * Ctrl-C, Ctrl-D or `quit` aborting gives QUIT.
 */
export async function ask(question: string, quit?: AbortSignal): Promise<Answer> {
  if (!process.stdin.isTTY) return undefined;
  return await askLine(process.stdin, process.stdout, question, quit);
}

export async function askLine(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  question: string,
  quit?: AbortSignal,
): Promise<Answer> {
  // In terminal mode readline reads Ctrl-C itself: no signal is raised, and with
  // no SIGINT listener it closes and abandons the question. Every way out has
  // to be caught here, or the open connection to NeonBinder holds the app open.
  const rl = createInterface({ input, output, terminal: true });
  let onQuit = () => {};
  try {
    return await new Promise<Answer>((resolve) => {
      let answered = false;
      onQuit = () => {
        if (answered) return;
        answered = true;
        output.write("\n");
        resolve(QUIT);
      };
      rl.once("SIGINT", onQuit);
      rl.once("close", onQuit);
      if (quit?.aborted) onQuit();
      quit?.addEventListener("abort", onQuit);
      rl.question(question).then((line) => resolve(line.trim()), onQuit);
    });
  } finally {
    quit?.removeEventListener("abort", onQuit);
    rl.off("close", onQuit);
    rl.off("SIGINT", onQuit);
    rl.close();
  }
}

/**
 * A line typed (or pasted) without echoing it, for the API key: it signs in
 * as the collector, so it shouldn't sit on screen. Each character shows as *.
 * Ctrl-C gives up (undefined).
 */
export async function askSecret(question: string): Promise<string | undefined> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return undefined;
  process.stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  try {
    return await new Promise<string | undefined>((resolve) => {
      let typed = "";
      const onData = (chunk: Buffer) => {
        // A paste in most terminals arrives wrapped in bracketed-paste markers.
        for (const ch of chunk.toString("utf8").replace(/\u001b\[20[01]~/g, "")) {
          if (ch === "\r" || ch === "\n") {
            stdin.off("data", onData);
            process.stdout.write("\n");
            resolve(typed.trim());
            return;
          }
          if (ch === "\u0003") {
            stdin.off("data", onData);
            process.stdout.write("\n");
            resolve(undefined);
            return;
          }
          if (ch === "\u007f" || ch === "\b") {
            if (typed) {
              typed = typed.slice(0, -1);
              process.stdout.write("\b \b");
            }
          } else if (ch >= " ") {
            typed += ch;
            process.stdout.write("*");
          }
        }
      };
      stdin.on("data", onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
}
