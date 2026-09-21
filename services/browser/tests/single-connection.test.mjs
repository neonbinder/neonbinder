/**
 * NEO-288: withSingleConnection — two sequential fetches on ONE socket.
 *
 * SportLots binds the automated-access authId to the client IP that minted
 * it. Node's global fetch, dispatched back-to-back, opens a SECOND TCP
 * connection for the signin even though the handshake socket is still open
 * and keep-alive (undici has not returned it to the pool yet). On Cloud Run's
 * egress pool the two sockets can carry different IPs and SportLots refuses
 * the signin. A dedicated undici Client is one connection by construction.
 *
 * These tests run against a real local http server with keep-alive and
 * record the server-side remote port of every request: same port = same
 * socket. The load-bearing assertion is the positive one (ONE socket through
 * withSingleConnection). The global-fetch control reproduces the race the fix
 * exists for; it is deterministic on every run seen so far, but it asserts a
 * behaviour of undici's pool rather than of our code.
 *
 * Also pinned: the client is closed after fn resolves AND after fn throws,
 * and a close blocked by an unconsumed body (undici backpressure) is bounded
 * — it falls back to destroy() instead of hanging the login route.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { withSingleConnection } = require("../dist/services/single-connection");

// Bigger than the fetch body stream's high-water mark (16 KiB), so an
// unconsumed body of this size leaves the socket under backpressure.
const BIG_BODY = "x".repeat(200 * 1024);

/** Start a keep-alive server that records the remote port of every request. */
function startServer() {
  const seen = []; // [{ path, method, port, body }]
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ path: req.url, method: req.method, port: req.socket.remotePort, body });
      if (req.url === "/handshake") {
        // What SportLots' automated-access endpoint answers with.
        res.setHeader("Keep-Alive", "timeout=5");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ success: true, authId: "x" }));
      } else if (req.url === "/signin") {
        // signin.tpl answers Connection: close.
        res.setHeader("Connection", "close");
        res.end("<html>ok</html>");
      } else if (req.url === "/big") {
        res.statusCode = 503;
        res.setHeader("Keep-Alive", "timeout=5");
        res.end(BIG_BODY);
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  server.keepAliveTimeout = 5_000;
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      resolve({
        server,
        origin,
        seen,
        reset: () => seen.splice(0),
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

/** The adapter's shape: handshake POST, read body, signin POST, read body. */
async function handshakeThenSignin(origin, doFetch) {
  const r1 = await doFetch(`${origin}/handshake`, { method: "POST", body: "{}" });
  await r1.text();
  const r2 = await doFetch(`${origin}/signin`, { method: "POST", body: "a=b" });
  await r2.text();
  return [r1.status, r2.status];
}

describe("withSingleConnection (NEO-288)", () => {
  let srv;
  before(async () => {
    srv = await startServer();
  });
  after(async () => {
    await srv.close();
  });

  it("two sequential fetches through the dispatcher land on ONE server-side socket", async () => {
    srv.reset();
    const statuses = await withSingleConnection(srv.origin, (dispatcher) =>
      handshakeThenSignin(srv.origin, (url, init) => fetch(url, { ...init, dispatcher })),
    );
    assert.deepEqual(statuses, [200, 200]);
    assert.equal(srv.seen.length, 2, "both requests reached the server");
    assert.deepEqual(
      srv.seen.map((r) => r.path),
      ["/handshake", "/signin"],
      "in order — pipelining:1 keeps them sequential",
    );
    assert.deepEqual(
      srv.seen.map((r) => r.method),
      ["POST", "POST"],
      "method survives the cross-version dispatch (Node's fetch → undici 7 Client)",
    );
    assert.deepEqual(srv.seen.map((r) => r.body), ["{}", "a=b"], "bodies survive too");
    assert.equal(
      new Set(srv.seen.map((r) => r.port)).size,
      1,
      "ONE socket: same remote port for the handshake and the signin",
    );
  });

  it("control: two sequential GLOBAL fetches with no gap land on TWO sockets (the race the fix exists for)", async () => {
    // This is undici's pool behaviour, not ours: after `await r1.text()` the
    // handshake socket has not been returned to the idle pool, so the signin
    // dispatched synchronously opens a second connection. If this ever
    // starts landing on one socket, undici changed — the positive test above
    // still holds and this control can be retired with a note.
    srv.reset();
    await handshakeThenSignin(srv.origin, (url, init) => fetch(url, init));
    assert.equal(srv.seen.length, 2);
    assert.equal(
      new Set(srv.seen.map((r) => r.port)).size,
      2,
      "global fetch: the two requests used two different sockets",
    );
  });

  it("closes the client after fn resolves", async () => {
    let client;
    const result = await withSingleConnection(srv.origin, async (dispatcher) => {
      client = dispatcher;
      assert.equal(client.closed, false, "open while fn runs");
      assert.equal(client.destroyed, false);
      const r = await fetch(`${srv.origin}/handshake`, { dispatcher });
      await r.text();
      return "value";
    });
    assert.equal(result, "value", "fn's return value is passed through");
    assert.ok(client, "fn received the dispatcher");
    assert.equal(client.closed, true, "close() was called");
    assert.equal(client.destroyed, true, "and the shutdown completed");
  });

  it("closes the client after fn throws, and rethrows fn's error", async () => {
    let client;
    const boom = new Error("fn failed");
    await assert.rejects(
      withSingleConnection(srv.origin, async (dispatcher) => {
        client = dispatcher;
        const r = await fetch(`${srv.origin}/handshake`, { dispatcher });
        await r.text();
        throw boom;
      }),
      (err) => err === boom,
      "the original error surfaces, not a teardown error",
    );
    assert.equal(client.closed, true);
    assert.equal(client.destroyed, true);
  });

  it("closes the client even when fn never dispatched anything", async () => {
    let client;
    await withSingleConnection(srv.origin, async (dispatcher) => {
      client = dispatcher;
    });
    assert.equal(client.destroyed, true);
  });

  it("an aborted in-flight request does not block the close", async () => {
    let client;
    const controller = new AbortController();
    await withSingleConnection(srv.origin, async (dispatcher) => {
      client = dispatcher;
      controller.abort();
      await assert.rejects(fetch(`${srv.origin}/handshake`, { dispatcher, signal: controller.signal }));
    });
    assert.equal(client.destroyed, true);
  });

  it("a close blocked by an UNCONSUMED body is bounded: falls back to destroy() instead of hanging", async () => {
    // Measured: with a 200 KB body left unread, client.close() never
    // resolves (undici holds the socket under backpressure). The adapter
    // discards every body it will not read, but the helper must not be able
    // to hang the login route if a caller forgets.
    let client;
    const t0 = Date.now();
    await withSingleConnection(
      srv.origin,
      async (dispatcher) => {
        client = dispatcher;
        const r = await fetch(`${srv.origin}/big`, { dispatcher });
        assert.equal(r.status, 503);
        // deliberately NOT reading or cancelling r.body
      },
      { closeTimeoutMs: 200 },
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 2_000, `returned promptly after the bound (took ${elapsed}ms)`);
    assert.equal(client.destroyed, true, "destroy() released the socket");
  });
});
