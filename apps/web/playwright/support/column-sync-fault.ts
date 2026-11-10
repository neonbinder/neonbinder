/**
 * NEO-450 — fake ONE set-builder column's failed sync in the browser, with no
 * hook in the product or in Convex (Jason, 2026-11-10: no product or test
 * hook in Convex; fake it at the network).
 *
 * A column draws its failed-sync alert from the reactive status query
 * `selectorOptions:getSelectorSyncStatus({ level, parentId })`. A real failure
 * needs a marketplace to fail on cue, so this helper stands in for the
 * server's status ROW instead: it sits on the Convex sync WebSocket
 * (`page.routeWebSocket`) and, while armed, answers that one subscription
 * with `{ status: "error", message }`, the shape a failed sync stores.
 * The fake ends the way a real error row does: the column's own retry (a
 * forced `selectorOptions:ensureSelectorOptions` for the same level and
 * parent) reaches the server, and once the server has answered it the column
 * is given the server's real status again. So a spec proves the alert, the
 * hidden empty line and that the column's `Sync <X>` button is the retry.
 *
 * ---------------------------------------------------------------------------
 * DEPENDS ON CONVEX'S INTERNAL SYNC PROTOCOL — written against convex 1.49.0
 * (`node_modules/convex/src/browser/sync/protocol.ts`, `client.ts`,
 * `remote_query_set.ts`). It is not a public API; a Convex upgrade can break
 * it, and `failStatus` throws, naming the version, when it finds nothing to
 * fake. What it assumes:
 *
 * - The client opens ONE WebSocket at `<deployment>/api/<version>/sync` and
 *   speaks JSON text frames.
 * - Client -> server: `ModifyQuerySet` carries `Add { queryId, udfPath, args:
 *   [argsObject] }` and `Remove { queryId }`; `udfPath` is canonical
 *   `module:function` (".js" stripped). `Action { requestId, udfPath, args:
 *   [argsObject] }` runs an action (its udfPath is not canonicalised).
 * - Server -> client: `Transition { startVersion, endVersion, modifications }`
 *   where a modification is `QueryUpdated { queryId, value, logLines,
 *   journal }`, `QueryFailed` or `QueryRemoved`. A large transition may come
 *   as `TransitionChunk { chunk, partNumber, totalParts, transitionId }`
 *   frames whose `chunk` strings join into one Transition's JSON.
 *   `ActionResponse { requestId }` answers an Action.
 * - The client accepts a Transition only when its `startVersion` equals the
 *   `endVersion` of the last one it applied (`RemoteQuerySet.transition`), and
 *   one with `startVersion === endVersion` changes no version, timestamp or
 *   auth state. That is the only way to hand an already-subscribed query a
 *   new value without the server, so arming and the retry's re-delivery are
 *   such no-op-version Transitions, sent between the server's own frames.
 *   Every server Transition is still forwarded in order, so the client's
 *   version never departs from the server's.
 * - A reconnect is a new socket: the route handler runs again and the client
 *   re-sends every `Add` there, so per-socket state starts empty.
 *
 * Every other frame, in both directions, is passed through untouched. The
 * fake keys on the query by udfPath plus its args (level and parentId), never
 * on a name of NB data. The parentId is the NB row id the set builder's own
 * address carries (`?brand=<id>`, NEO-224).
 * ---------------------------------------------------------------------------
 */
import type { Page, WebSocketRoute } from "@playwright/test";

const STATUS_QUERY = "selectorOptions:getSelectorSyncStatus";
const ENSURE_ACTION = "selectorOptions:ensureSelectorOptions";

/**
 * What a failed sync stores on its status row: `SYNC_ERROR_MESSAGE` in
 * convex/selectorOptions.ts (not importable here: that module pulls in the
 * Convex server runtime). The column must NOT render it (NEO-450 names the
 * column instead), so a spec that finds the column's own sentence also proves
 * the server's generic one was not echoed.
 */
const SERVER_ERROR_MESSAGE = "Couldn't sync options — please try again.";

/** The Convex client's sync socket: `${wsProtocol}://${origin}/api/${version}/sync`. */
function isConvexSync(url: URL): boolean {
  return /^wss?:$/.test(url.protocol) && /^\/api\/[^/]+\/sync$/.test(url.pathname);
}

/** convex/src/browser/sync/udf_path_utils.ts `canonicalizeUdfPath`. */
function canonical(udfPath: string): string {
  const i = udfPath.lastIndexOf(":");
  const mod = i === -1 ? udfPath : udfPath.slice(0, i);
  const fn = i === -1 ? "default" : udfPath.slice(i + 1);
  return `${mod.replace(/\.js$/, "")}:${fn}`;
}

export interface ColumnStatusTarget {
  /** The column's level, as the query takes it: "setName" for Sets. */
  level: string;
  /** The column's parent row id (Sets: the brand), from the set builder's address. */
  parentId: string;
}

type JsonObject = Record<string, unknown>;

interface Version {
  querySet: number;
  ts: string;
  identity: number;
}

interface Modification {
  type: "QueryUpdated" | "QueryFailed" | "QueryRemoved";
  queryId: number;
  journal?: unknown;
  [key: string]: unknown;
}

interface Transition {
  type: "Transition";
  startVersion: Version;
  endVersion: Version;
  modifications: Modification[];
  [key: string]: unknown;
}

/** One sync socket: what the client subscribed on it and what it last applied. */
interface Socket {
  page: WebSocketRoute;
  /** queryId -> args of each live getSelectorSyncStatus subscription. */
  statusArgs: Map<number, JsonObject>;
  /** queryId -> the last modification the SERVER sent for it (real, never the fake). */
  lastReal: Map<number, Modification>;
  /** endVersion of the last Transition forwarded to the page: the client's version. */
  version: Version | null;
  /** requestIds of forced ensures for the armed target, awaiting their answer. */
  retries: Set<number>;
  /** A chunked Transition being reassembled: its raw frames and parts. */
  chunked: { id: string; frames: string[]; parts: string[] } | null;
}

export interface ColumnSyncFault {
  /**
   * From now on, the column's status query answers `{ status: "error" }`. A
   * subscription that already holds a value is re-delivered the fake at once;
   * a later one gets it as its first value. Ends when the column's own retry
   * is answered by the server. Throws when no live subscription matches.
   */
  failStatus(target: ColumnStatusTarget): void;
  /** Forced syncs of the armed column the server has answered (each one ends the fake). */
  retriesAnswered(): number;
}

function parse(frame: string): JsonObject | null {
  try {
    const value: unknown = JSON.parse(frame);
    return value && typeof value === "object" ? (value as JsonObject) : null;
  } catch {
    return null;
  }
}

/**
 * Install BEFORE the page opens the app (before `signIn`): a route only
 * catches sockets opened after it exists.
 */
export async function faultColumnSyncStatus(page: Page): Promise<ColumnSyncFault> {
  let target: ColumnStatusTarget | null = null;
  let answered = 0;
  const sockets = new Set<Socket>();

  const matches = (args: JsonObject | undefined, t: ColumnStatusTarget | null): boolean =>
    !!t && !!args && args.level === t.level && args.parentId === t.parentId;

  const fake = (queryId: number, real: Modification | undefined): Modification => ({
    type: "QueryUpdated",
    queryId,
    value: { status: "error", message: SERVER_ERROR_MESSAGE },
    logLines: [],
    journal: real?.journal ?? null,
  });

  /**
   * A no-op-version Transition (see the header): new values, same version.
   * A socket that has applied no Transition yet has no version to inject at,
   * so it is skipped (it also holds no value to replace); `failStatus` is the
   * one caller that treats that as an error.
   */
  const inject = (s: Socket, modifications: Modification[]): void => {
    if (modifications.length === 0 || !s.version) return;
    s.page.send(
      JSON.stringify({ type: "Transition", startVersion: s.version, endVersion: s.version, modifications }),
    );
  };

  /** Forward one server Transition, rewriting only the armed query's value. */
  const deliver = (s: Socket, t: Transition, rawFrames: string[]): void => {
    let touched = false;
    const modifications = t.modifications.map((m) => {
      if (!s.statusArgs.has(m.queryId)) return m;
      if (m.type === "QueryRemoved") {
        s.lastReal.delete(m.queryId);
        return m;
      }
      s.lastReal.set(m.queryId, m);
      if (!matches(s.statusArgs.get(m.queryId), target)) return m;
      touched = true;
      return fake(m.queryId, m);
    });
    s.version = t.endVersion;
    if (touched) s.page.send(JSON.stringify({ ...t, modifications }));
    else for (const raw of rawFrames) s.page.send(raw);
  };

  await page.routeWebSocket(isConvexSync, (ws) => {
    const server = ws.connectToServer();
    const s: Socket = {
      page: ws,
      statusArgs: new Map(),
      lastReal: new Map(),
      version: null,
      retries: new Set(),
      chunked: null,
    };
    sockets.add(s);

    // Page -> server: always forwarded untouched; read only to learn which
    // queryId is which subscription and to spot the column's retry.
    ws.onMessage((frame) => {
      server.send(frame);
      if (typeof frame !== "string") return;
      const msg = parse(frame);
      if (msg?.type === "ModifyQuerySet" && Array.isArray(msg.modifications)) {
        for (const m of msg.modifications as JsonObject[]) {
          const queryId = m.queryId as number;
          if (m.type === "Add" && canonical(String(m.udfPath)) === STATUS_QUERY) {
            s.statusArgs.set(queryId, ((m.args as JsonObject[] | undefined) ?? [])[0] ?? {});
          } else if (m.type === "Remove") {
            s.statusArgs.delete(queryId);
            s.lastReal.delete(queryId);
          }
        }
      } else if (msg?.type === "Action" && canonical(String(msg.udfPath)) === ENSURE_ACTION) {
        const args = ((msg.args as JsonObject[] | undefined) ?? [])[0];
        if (matches(args, target) && args?.force === true) s.retries.add(msg.requestId as number);
      }
    });

    // Server -> page: untouched unless it carries the armed query's value.
    server.onMessage((frame) => {
      const msg = typeof frame === "string" ? parse(frame) : null;
      if (msg?.type === "Transition") {
        deliver(s, msg as unknown as Transition, [frame as string]);
      } else if (msg?.type === "TransitionChunk") {
        // Held until the last part: only the whole Transition says whether
        // it carries the armed query. The client buffers parts the same way.
        const id = String(msg.transitionId);
        if (!s.chunked || s.chunked.id !== id) s.chunked = { id, frames: [], parts: [] };
        s.chunked.frames.push(frame as string);
        s.chunked.parts.push(String(msg.chunk));
        if (s.chunked.parts.length === msg.totalParts) {
          const { frames, parts } = s.chunked;
          s.chunked = null;
          const whole = parse(parts.join(""));
          if (whole?.type === "Transition") deliver(s, whole as unknown as Transition, frames);
          else for (const raw of frames) ws.send(raw);
        }
      } else if (msg?.type === "ActionResponse" && s.retries.delete(msg.requestId as number)) {
        // The server has run the column's retry, which replaces a real error
        // row. Forward its answer first, so nothing below can withhold it from
        // the page; then end the fake everywhere and hand back the server's
        // own value.
        ws.send(frame);
        const was = target;
        target = null;
        answered += 1;
        for (const each of sockets) {
          const real: Modification[] = [];
          for (const [queryId, args] of each.statusArgs) {
            const last = each.lastReal.get(queryId);
            if (last && matches(args, was)) real.push(last);
          }
          inject(each, real);
        }
      } else {
        ws.send(frame);
      }
    });

    // Closing either side closes the other (the default this replaces), and
    // the socket stops being a target.
    // A WebSocket may only be closed with 1000 or 3000-4999; any other code
    // (1006 for a dropped line) closes without one. When the SERVER drops the
    // socket that way the original code and reason are logged, so a reconnect
    // mid-spec is not silent; a page-side close (a navigation, the page
    // closing) has no code by nature and is not. Never a frame.
    const reusable = (code: number | undefined): code is number =>
      code === 1000 || (code !== undefined && code >= 3000 && code <= 4999);
    // Whichever side closes first is the real close; the other side's close
    // event is then the echo of the one forwarded here, and is ignored.
    let closed = false;
    ws.onClose((code, reason) => {
      if (closed) return;
      closed = true;
      sockets.delete(s);
      void server.close(reusable(code) ? { code, reason } : {}).catch(() => {});
    });
    server.onClose((code, reason) => {
      if (closed) return;
      closed = true;
      sockets.delete(s);
      if (!reusable(code)) {
        console.warn(
          `column-sync-fault: the Convex server closed the sync socket with code ${code ?? "none"} (${reason || "no reason"}); closing the page side without a code`,
        );
      }
      void ws.close(reusable(code) ? { code, reason } : {}).catch(() => {});
    });
  });

  return {
    failStatus(t) {
      target = t;
      let found = 0;
      for (const s of sockets) {
        const fakes: Modification[] = [];
        for (const [queryId, args] of s.statusArgs) {
          if (!matches(args, t)) continue;
          found += 1;
          const last = s.lastReal.get(queryId);
          if (last) fakes.push(fake(queryId, last));
        }
        if (fakes.length > 0 && !s.version) {
          throw new Error("column-sync-fault: no Transition seen on this socket yet, so there is no version to inject at");
        }
        inject(s, fakes);
      }
      if (found === 0) {
        throw new Error(
          `column-sync-fault: no live ${STATUS_QUERY} subscription for ${t.level} under ${t.parentId}. ` +
            "Is the column open? If it is, Convex's sync protocol may have changed (written against convex 1.49.0).",
        );
      }
    },
    retriesAnswered: () => answered,
  };
}
