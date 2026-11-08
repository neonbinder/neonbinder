import { savedKey, saveKey } from "./config.js";
import { KeyRejectedError, NeonBinder } from "./neonbinder.js";

/**
 * Which API key the app uses, and what happens when NeonBinder refuses it. A
 * key refused partway through a working day goes the same way as one refused
 * at the start: the saved copy is dropped and the app asks for another, without
 * having to be opened again. A key from the environment isn't ours to replace,
 * so that one ends the app.
 */

export interface SignInDeps {
  convexUrl: string;
  keyFile: string;
  /** A key from the environment, used instead of the saved one and never saved. */
  envKey?: string;
  siteOverride?: string;
  log: (line: string) => void;
  /** Undefined when there's no keyboard, or the person gave up. */
  askKey: (question: string) => Promise<string | undefined>;
}

export interface SignedIn {
  nb: NeonBinder;
  /** The key is the saved one, so refusing it should forget it. */
  keyIsSaved: boolean;
}

/** Sign in with the env key, the saved key, or one asked for (then saved). */
export async function signIn(deps: SignInDeps): Promise<SignedIn | undefined> {
  const { convexUrl, keyFile, envKey, siteOverride, log, askKey } = deps;
  if (envKey) return { nb: await NeonBinder.signIn(convexUrl, envKey, siteOverride), keyIsSaved: false };
  let key = await savedKey(keyFile, convexUrl);
  let asked = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!key) {
      log("Paste your NeonBinder API key (NeonBinder → Profile → API Keys). It's saved on this computer.");
      key = await askKey("API key: ");
      if (!key) return undefined;
      asked = true;
    }
    try {
      const nb = await NeonBinder.signIn(convexUrl, key, siteOverride);
      if (asked) {
        await saveKey(keyFile, convexUrl, key);
        // The next prompt echoes what's pasted into it, and copying the key replaced the code.
        log("Your clipboard still has that key. Go back to NeonBinder and copy the scanner code before you paste.");
      }
      return { nb, keyIsSaved: true };
    } catch (error) {
      if (!(error instanceof KeyRejectedError)) throw error;
      log(error.message);
      await saveKey(keyFile, convexUrl, undefined);
      key = undefined;
    }
  }
  return undefined;
}

/** Sign in and run `scan`, signing in again if NeonBinder refuses the key along the way. */
export async function scanSignedIn(
  deps: SignInDeps,
  scan: (nb: NeonBinder, firstCode?: string) => Promise<number>,
  firstCode?: string,
): Promise<number> {
  let code = firstCode;
  for (;;) {
    const signedIn = await signIn(deps);
    if (!signedIn) {
      deps.log("No API key, so nothing to do. Make one under Profile → API Keys and run this again.");
      return 1;
    }
    try {
      return await scan(signedIn.nb, code);
    } catch (error) {
      if (!(error instanceof KeyRejectedError)) throw error;
      deps.log(error.message);
      if (!signedIn.keyIsSaved) return 1;
      await saveKey(deps.keyFile, deps.convexUrl, undefined);
      code = undefined;
    } finally {
      await signedIn.nb.close();
    }
  }
}
