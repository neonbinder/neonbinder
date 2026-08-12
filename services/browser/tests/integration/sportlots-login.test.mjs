import { describe, it, after } from "node:test";
import {
  assertLoginOk,
  deleteCredentials,
  postLogin,
  probeKey,
  requireEnv,
} from "./_helpers.mjs";

const KEY = probeKey("sportlots");

describe("POST /login/sportlots against deployed target", () => {
  const username = requireEnv("SPORTLOTS_USERNAME");
  const password = requireEnv("SPORTLOTS_PASSWORD");

  // No seed step: the first test's login carries the credentials and
  // updateCredentials creates the secret when it does not exist. The PUT
  // /credentials/:key route this used to call has been removed.

  after(async () => {
    await deleteCredentials(KEY);
  });

  it("authenticates to SportLots with transient credentials and returns success", async () => {
    const result = await postLogin("sportlots", KEY, { credentials: { username, password } });
    assertLoginOk(result);
  });

  it("then re-authenticates with NO credentials at all, via the stored session cookie", async () => {
    // The first login banked the SL session cookie; this one must succeed on
    // that alone, with no password stored anywhere.
    const result = await postLogin("sportlots", KEY);
    assertLoginOk(result);
  });
});
