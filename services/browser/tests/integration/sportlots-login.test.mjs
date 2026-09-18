import { describe, it, after } from "node:test";
import {
  assertLoginOk,
  deleteCredentials,
  isPaused,
  postLogin,
  probeKey,
  requireEnv,
} from "./_helpers.mjs";

const KEY = probeKey("sportlots");
const PAUSED = isPaused("sportlots");

if (PAUSED) {
  console.log("::notice::SportLots login probe skipped — platform paused");
}

describe("POST /login/sportlots against deployed target", () => {
  // Required only when the probe actually runs — while SportLots is paused
  // (NEO-287) CI may not carry these secrets at all, and requiring them here
  // would fail the file at load time before either `it.skip` ever ran.
  const username = PAUSED ? undefined : requireEnv("SPORTLOTS_USERNAME");
  const password = PAUSED ? undefined : requireEnv("SPORTLOTS_PASSWORD");

  // No seed step: the first test's login carries the credentials and
  // updateCredentials creates the secret when it does not exist. The PUT
  // /credentials/:key route this used to call has been removed.

  after(async () => {
    if (PAUSED) return;
    await deleteCredentials(KEY);
  });

  (PAUSED ? it.skip : it)(
    "authenticates to SportLots with transient credentials and returns success",
    async () => {
      const result = await postLogin("sportlots", KEY, { credentials: { username, password } });
      assertLoginOk(result);
    },
  );

  (PAUSED ? it.skip : it)(
    "then re-authenticates with NO credentials at all, via the stored session cookie",
    async () => {
      // The first login banked the SL session cookie; this one must succeed on
      // that alone, with no password stored anywhere.
      const result = await postLogin("sportlots", KEY);
      assertLoginOk(result);
    },
  );
});
