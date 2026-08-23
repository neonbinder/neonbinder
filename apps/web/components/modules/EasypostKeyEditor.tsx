"use client";

import { useCallback, useEffect, useState } from "react";
import { useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import NeonButton from "./NeonButton";
import { Input } from "@/components/primitives/Input";

/**
 * NEO-120 — the seller's EasyPost API key, used to buy letter postage.
 *
 * ## The key is never shown back
 * There is deliberately no "reveal" and no prefilled value. The key lives in
 * GCP Secret Manager behind the browser service, and no route hands it back —
 * the same boundary that protects marketplace passwords (NEO-20). The UI can
 * only ever know *whether* a key exists, never what it is. A field that looks
 * empty when a key IS saved would be confusing, so the saved state is stated in
 * words instead.
 *
 * This key spends the seller's money, which is why it gets the credential
 * boundary rather than sitting in Convex like a preference.
 */
export default function EasypostKeyEditor() {
  const hasKey = useAction(api.postage.hasEasypostKey);
  const saveKey = useAction(api.postage.saveEasypostKey);
  const clearKey = useAction(api.postage.clearEasypostKey);

  const [saved, setSaved] = useState<boolean | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error">("success");

  /** Re-read whether a key is stored. Called from handlers, never from render. */
  const refresh = useCallback(async () => {
    try {
      setSaved(await hasKey({}));
    } catch {
      // Treat an unreachable check as "unknown" rather than "none saved" — the
      // latter would invite someone to re-paste a key that is already stored.
      setSaved(null);
    }
  }, [hasKey]);

  /**
   * Mount-only read of remote state.
   *
   * The empty dependency array is a **bug fix, not a style choice.** This cannot
   * be a `useQuery` — knowing whether a key exists means asking the browser
   * service, and only Convex *actions* may call out — so it has to be an
   * effect. Depending on `refresh` (which depends on the action identity) made
   * the effect re-run on any render that produced a fresh identity, which called
   * setState, which re-rendered: an infinite loop hammering
   * `/credentials/check` and leaving the page permanently re-rendering.
   *
   * It surfaced as the e2e worker bootstrap hanging for its full 600s timeout on
   * `Tap on "Test Credentials"` — maestro-web waits for the view hierarchy to
   * settle before tapping, and a looping page never settles. Every other flow
   * that visits /profile would have hung the same way, and in production this
   * would have been a profile page quietly DDoSing the credential service.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await hasKey({});
        if (!cancelled) setSaved(result);
      } catch {
        if (!cancelled) setSaved(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only by design; see above. Adding `hasKey` reintroduces the render loop.
  }, []);

  const handleSave = useCallback(async () => {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      setMessage("Paste your EasyPost API key first.");
      setMessageType("error");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const result = await saveKey({ apiKey: trimmed });
      setMessage(result.message);
      setMessageType(result.success ? "success" : "error");
      if (result.success) {
        // Drop it from component state the moment it is stored — no reason for
        // the key to linger in memory or in a form field.
        setApiKey("");
        await refresh();
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save the key.");
      setMessageType("error");
    } finally {
      setBusy(false);
    }
  }, [apiKey, refresh, saveKey]);

  const handleClear = useCallback(async () => {
    setBusy(true);
    setMessage("");
    try {
      const result = await clearKey({});
      setMessage(result.message);
      setMessageType(result.success ? "success" : "error");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not remove the key.");
      setMessageType("error");
    } finally {
      setBusy(false);
    }
  }, [clearKey, refresh]);

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-400">
        Connect EasyPost to buy postage for your labels — about $0.80 for a 1oz
        letter, a little less than a stamp. Postage is charged to your own
        EasyPost account; NeonBinder never handles the money.
      </p>

      <p className="text-sm">
        {saved === null ? (
          <span className="text-slate-400">Checking connection…</span>
        ) : saved ? (
          <span className="text-neon-green">EasyPost key saved.</span>
        ) : (
          <span className="text-slate-400">No EasyPost key saved yet.</span>
        )}
      </p>

      <div>
        <label htmlFor="easypost-key" className="block text-sm font-medium mb-1 text-slate-300">
          {saved ? "Replace API key" : "API key"}
        </label>
        <Input
          bare
          id="easypost-key"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          className="w-full px-3 py-2 font-mono text-sm"
          placeholder="EZAK…"
          autoComplete="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          aria-describedby="easypost-key-hint"
        />
        <p id="easypost-key-hint" className="text-xs text-slate-400 mt-1">
          Find it in EasyPost under Account Settings → API Keys. Use a Production
          key to buy real postage; a Test key prices labels without charging.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <NeonButton type="button" onClick={() => void handleSave()} disabled={busy}>
          {busy ? "Saving…" : saved ? "Replace key" : "Save key"}
        </NeonButton>
        {saved && (
          <button
            type="button"
            onClick={() => void handleClear()}
            disabled={busy}
            className="text-sm text-slate-400 hover:text-slate-200 underline p-2 -m-2 disabled:opacity-50"
          >
            Remove key
          </button>
        )}
      </div>

      {/* Always mounted so the announcement is reliable. */}
      <p
        role={messageType === "error" ? "alert" : "status"}
        aria-live={messageType === "error" ? "assertive" : "polite"}
        className={`text-sm ${
          messageType === "success" ? "text-neon-green" : "text-neon-pink"
        }`}
      >
        {message}
      </p>
    </div>
  );
}
