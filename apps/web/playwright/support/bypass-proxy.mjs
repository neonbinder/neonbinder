// localhost:3000 -> Vercel preview, injecting the deployment-protection
// bypass header on every request. A copy of the proxy the Maestro runner
// action starts (apps/web/.github/actions/maestro-runner/action.yml), so both
// suites reach the preview the same way. Started by playwright.config.ts's
// `webServer` when PREVIEW_URL is set. Reads the secret from the environment;
// never logs it.
import http from "node:http";
import https from "node:https";

const upstream = new URL(process.env.PREVIEW_URL);
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET ?? "";
const PORT = Number(process.env.PROXY_PORT ?? 3000);

const server = http.createServer((req, res) => {
  const upstreamReq = https.request(
    {
      hostname: upstream.hostname,
      port: 443,
      path: req.url,
      method: req.method,
      headers: {
        ...req.headers,
        host: upstream.hostname,
        "x-vercel-protection-bypass": bypass,
        // NEO-548: keep Vercel's preview toolbar (a viewport-fixed round button on the
        // right edge) out of the page. On the phone project it sat over the drawer's
        // Sell button and intercepted the click. Vercel's "Disable toolbar for
        // automation" docs: the header's presence on the request to the preview URL is
        // enough. It rides only through this proxy, never to Convex or Clerk.
        "x-vercel-skip-toolbar": "1",
      },
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 500, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstreamReq.on("error", (err) => {
    console.error("proxy error:", err.message);
    res.statusCode = 502;
    res.end("proxy error");
  });
  req.pipe(upstreamReq);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Bypass proxy listening on http://localhost:${PORT} -> ${upstream.origin}`);
});
