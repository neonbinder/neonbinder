import { describe, it, before, after } from "node:test";
import {
  assertLoginOk,
  deleteCredentials,
  postLogin,
  probeKey,
  putCredentials,
  requireEnv,
} from "./_helpers.mjs";

const KEY = probeKey("bsc");

describe("POST /login/bsc against deployed target", () => {
  const username = requireEnv("BSC_USERNAME");
  const password = requireEnv("BSC_PASSWORD");

  before(async () => {
    await putCredentials(KEY, { username, password });
  });

  after(async () => {
    await deleteCredentials(KEY);
  });

  it("authenticates to BuySportsCards and returns success", async () => {
    const result = await postLogin("bsc", KEY);
    assertLoginOk(result);
  });
});
