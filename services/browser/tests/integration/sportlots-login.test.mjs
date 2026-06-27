import { describe, it, before, after } from "node:test";
import {
  assertLoginOk,
  deleteCredentials,
  postLogin,
  probeKey,
  putCredentials,
  requireEnv,
} from "./_helpers.mjs";

const KEY = probeKey("sportlots");

describe("POST /login/sportlots against deployed target", () => {
  const username = requireEnv("SPORTLOTS_USERNAME");
  const password = requireEnv("SPORTLOTS_PASSWORD");

  before(async () => {
    await putCredentials(KEY, { username, password });
  });

  after(async () => {
    await deleteCredentials(KEY);
  });

  it("authenticates to SportLots and returns success", async () => {
    const result = await postLogin("sportlots", KEY);
    assertLoginOk(result);
  });
});
