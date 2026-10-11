// Port of .maestro/flows/profile/api-keys-create-copy-and-revoke.yaml
import { test } from "../../support/fixtures";

test(
  "API Keys — create a key, copy the secret once, then revoke it",
  { tag: ["@smoke", "@api-keys"] },
  async ({ m, env }) => {
    const KEY = `e2e-${env.ATTEMPT_ID}`;
    await m.launch(m.signInUrl("/profile/shipping"));
    await m.waitVisible("Profile Settings", 45_000);

    await m.tapOn("API Keys");

    await m.assertVisible(".*An API key lets a script, spreadsheet or tool talk to Neon Binder as you.*");
    await m.assertVisible(".*The secret is shown once, when you create the key.*");

    await m.scrollUntilVisible("Add new key", { timeout: 7_000 });
    await m.tapOn("Add new key");

    await m.scrollUntilVisible("Enter your secret key name", { timeout: 7_000 });
    await m.assertVisible("Add new API key");
    await m.tapOn("Enter your secret key name");
    await m.inputText(KEY);
    await m.assertVisible(m.value(KEY)); // Maestro `text:` matches the input's value
    await m.tapOn("Select date");
    await m.tapOn("1 Day");
    await m.assertVisible(".*Expiring.*");
    await m.scrollUntilVisible("Create key", { timeout: 7_000 });
    await m.tapOn("Create key");

    await m.assertVisible(`.*Copy your.*${KEY}.*API Key now.*`);
    await m.assertVisible(".*allow you to view it again later.*");
    await m.tapOn("Copy & Close");

    await m.scrollUntilVisible("Search keys", { timeout: 7_000 });
    await m.tapOn("Search keys");
    await m.inputText(KEY);
    await m.scrollUntilVisible(m.below(KEY, "Name"), { timeout: 7_000 });
    await m.assertVisible(".*Created.*Expires.*");

    await m.tapOn(m.rightOf(m.id("Open menu"), KEY));
    await m.tapOn("Revoke key");

    await m.assertVisible(`.*Revoke.*${KEY}.*secret key.*`);
    await m.tapOn("Revoke");
    await m.inputText("Revoke");
    await m.tapOn("Revoke key");

    await m.scrollUntilVisible("No API keys found", { timeout: 7_000 });
  },
);
