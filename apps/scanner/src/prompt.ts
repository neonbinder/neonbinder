import { createInterface } from "node:readline/promises";

/** One line from the keyboard. Undefined when there is no keyboard (piped). */
export async function ask(question: string): Promise<string | undefined> {
  if (!process.stdin.isTTY) return undefined;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
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
