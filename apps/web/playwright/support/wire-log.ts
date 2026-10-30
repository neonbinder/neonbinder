/**
 * EXPERIMENT (do not merge): what the browser saw, attached to a failed test.
 *
 * The server's call log shows a page that stopped asking (a binder delete
 * whose `remove` never arrived after `empty` answered). This records the
 * client side so a failure says whether the answer reached the page, whether
 * the next call was sent, and whether the Convex socket dropped.
 *
 * Recorded: page errors, console errors and warnings, Convex websocket opens
 * and closes, and one line per Convex frame naming its type, request id and
 * function path. NEVER recorded: arguments, results, query values or the
 * Authenticate token. Blob reports are public artifacts (playwright.config.ts).
 */
import type { Page, TestInfo } from "@playwright/test";

const JWT = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g;
const MAX_LINES = 4000;

function redact(text: string): string {
  return text.replace(JWT, "<jwt>").slice(0, 500);
}

type Frame = {
  type?: string;
  requestId?: number;
  udfPath?: string;
  success?: boolean;
  modifications?: Array<{ type?: string; udfPath?: string; queryId?: number }>;
  endVersion?: { querySet?: number };
};

function describeFrame(raw: string | Buffer): string | null {
  if (typeof raw !== "string") return "binary";
  let f: Frame;
  try {
    f = JSON.parse(raw) as Frame;
  } catch {
    return "unparsed";
  }
  switch (f.type) {
    case "Ping":
      return null;
    case "Mutation":
    case "Action":
      return `${f.type} #${f.requestId} ${f.udfPath}`;
    case "MutationResponse":
    case "ActionResponse":
      return `${f.type} #${f.requestId} success=${f.success}`;
    case "ModifyQuerySet": {
      const mods = f.modifications ?? [];
      const added = mods.filter((m) => m.type === "Add").map((m) => m.udfPath);
      const removed = mods.filter((m) => m.type === "Remove").length;
      return `ModifyQuerySet +[${added.join(",")}] -${removed}`;
    }
    case "Transition":
      return `Transition querySet=${f.endVersion?.querySet} updates=${(f.modifications ?? []).length}`;
    default:
      // Connect, Authenticate, AuthError, FatalError, ...: the type alone.
      return String(f.type);
  }
}

export function recordWire(page: Page): () => string[] {
  const start = Date.now();
  const lines: string[] = [];
  const add = (line: string) => {
    if (lines.length < MAX_LINES) lines.push(`${String(Date.now() - start).padStart(7)}ms ${line}`);
  };

  page.on("pageerror", (e) => add(`PAGEERROR ${redact(e.message)}`));
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") add(`CONSOLE.${m.type()} ${redact(m.text())}`);
  });
  page.on("framenavigated", (fr) => {
    if (fr === page.mainFrame()) add(`NAVIGATED ${new URL(fr.url()).pathname}`);
  });
  page.on("websocket", (ws) => {
    const host = new URL(ws.url()).host;
    if (!host.includes("convex")) return;
    add(`WS open ${host}`);
    ws.on("close", () => add("WS close"));
    ws.on("socketerror", (e) => add(`WS error ${redact(String(e))}`));
    ws.on("framesent", (f) => {
      const d = describeFrame(f.payload);
      if (d) add(`-> ${d}`);
    });
    ws.on("framereceived", (f) => {
      const d = describeFrame(f.payload);
      if (d) add(`<- ${d}`);
    });
  });
  return () => lines;
}

export async function attachWireOnFailure(testInfo: TestInfo, lines: string[]): Promise<void> {
  if (testInfo.status === testInfo.expectedStatus) return;
  await testInfo.attach("client-wire.log", { contentType: "text/plain", body: lines.join("\n") });
}
