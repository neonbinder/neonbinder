import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { askLine, QUIT } from "./prompt.js";

/**
 * The code prompt in terminal mode, as it runs on a real keyboard: readline
 * reads Ctrl-C and Ctrl-D itself, so both have to come back as an answer or the
 * open connection to NeonBinder keeps the app alive with nothing asking.
 */
function terminal() {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  return { input, output };
}

describe("askLine", () => {
  test("gives the line typed, trimmed", async () => {
    const { input, output } = terminal();
    const answer = askLine(input, output, "Scanner code: ");
    input.write("  ABC 123 \r");
    await expect(answer).resolves.toBe("ABC 123");
  });

  test("an empty Enter is an empty answer, not a way out", async () => {
    const { input, output } = terminal();
    const answer = askLine(input, output, "Scanner code: ");
    input.write("\r");
    await expect(answer).resolves.toBe("");
  });

  test.each([
    ["Ctrl-C", "\u0003"],
    ["Ctrl-D", "\u0004"],
  ])("%s quits", async (_name, key) => {
    const { input, output } = terminal();
    const answer = askLine(input, output, "Scanner code: ");
    input.write(key);
    await expect(answer).resolves.toBe(QUIT);
  });

  test("the abort signal quits, also when it already fired", async () => {
    const { input, output } = terminal();
    const quit = new AbortController();
    const answer = askLine(input, output, "Scanner code: ", quit.signal);
    quit.abort();
    await expect(answer).resolves.toBe(QUIT);
    await expect(askLine(input, output, "Scanner code: ", quit.signal)).resolves.toBe(QUIT);
  });

  test("asking twice in a row works, and leaves nothing listening for the quit", async () => {
    const { input, output } = terminal();
    const quit = new AbortController();
    const first = askLine(input, output, "Scanner code: ", quit.signal);
    input.write("one\r");
    await expect(first).resolves.toBe("one");
    const second = askLine(input, output, "Scanner code: ", quit.signal);
    input.write("two\r");
    await expect(second).resolves.toBe("two");
  });
});
