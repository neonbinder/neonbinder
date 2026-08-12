import { describe, it, after } from "node:test";
import {
  assertLoginOk,
  deleteCredentials,
  postLogin,
  probeKey,
  requireEnv,
} from "./_helpers.mjs";

const KEY = probeKey("bsc");

describe("POST /login/bsc against deployed target", () => {
  const username = requireEnv("BSC_USERNAME");
  const password = requireEnv("BSC_PASSWORD");

  // No seed step: the first test's login carries the credentials and
  // updateCredentials creates the secret when it does not exist. The PUT
  // /credentials/:key route this used to call has been removed.

  after(async () => {
    await deleteCredentials(KEY);
  });

  it("authenticates to BuySportsCards with transient credentials and returns success", async () => {
    const result = await postLogin("bsc", KEY, { credentials: { username, password } });
    assertLoginOk(result);
  });

  it("then re-authenticates with NO credentials at all, via the stored refresh token", async () => {
    // The point of NEO-141 end-to-end: the first login banked a rotating
    // refresh token, so this call must succeed against the real B2C tenant
    // with nothing in the body but the key — no password anywhere in the
    // system. If BSC ever stops issuing refresh tokens under our scope, this
    // is the test that catches it.
    const result = await postLogin("bsc", KEY);
    assertLoginOk(result);
  });
});
