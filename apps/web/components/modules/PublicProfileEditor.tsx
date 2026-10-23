import { useState, useEffect, useRef, useCallback, useId } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import NeonButton from "./NeonButton";
import { Input } from "../primitives/Input";

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/**
 * NEO-111 — these three live at module scope, not inside PublicProfileEditor.
 *
 * Declaring a component inside another component's body makes it a NEW
 * component type on every render, so React unmounts and remounts it rather than
 * updating it: local state and focus are destroyed each keystroke. Harmless for
 * a stateless button today, but it is the kind of thing that quietly breaks the
 * moment one of them gains state — and this file is already the home of one
 * reactive-form bug (NEO-41). Flagged by react-hooks/static-components.
 *
 * Closure values they used to capture are now explicit props.
 */
const LINK_BUTTON_CLASS =
  "text-xs text-neon-blue-text hover:text-neon-blue-text/80 transition-colors";

function FillButton({
  onClick,
  url,
  canInfer,
}: {
  onClick: () => void;
  url: string;
  canInfer: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={!canInfer}
      className={`${LINK_BUTTON_CLASS} disabled:text-ink-3 disabled:cursor-not-allowed break-all text-right`}
      title={canInfer ? "Click to fill with inferred URL" : "Enter a username first"}
    >
      {url}
    </button>
  );
}

function BscButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className={LINK_BUTTON_CLASS}>
      Find my BSC url
    </button>
  );
}

function MySlabsButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className={LINK_BUTTON_CLASS}>
      Find my MySlabs url
    </button>
  );
}

export default function PublicProfileEditor() {
  const existingProfile = useQuery(api.publicProfile.getMyPublicProfile);

  // Basic info
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [tagline, setTagline] = useState("");

  // Photo
  const [stagedPhotoBase64, setStagedPhotoBase64] = useState<string | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Colors
  const [brandColor1, setBrandColor1] = useState("#00D558");
  const [brandColor2, setBrandColor2] = useState("#A44AFF");

  // Marketplace URLs
  const [ebayUrl, setEbayUrl] = useState("");
  const [buySportsCardsUrl, setBuySportsCardsUrl] = useState("");
  const [sportlotsUrl, setSportlotsUrl] = useState("");
  const [mySlabsUrl, setMySlabsUrl] = useState("");
  const [myCardPostUrl, setMyCardPostUrl] = useState("");

  // Payment handles
  const [paypalUsername, setPaypalUsername] = useState("");
  const [paypalEmail, setPaypalEmail] = useState("");
  const [venmoUsername, setVenmoUsername] = useState("");
  const [cashAppUsername, setCashAppUsername] = useState("");

  // Social URLs
  const [twitterUrl, setTwitterUrl] = useState("");
  const [instagramUrl, setInstagramUrl] = useState("");
  const [tiktokUrl, setTiktokUrl] = useState("");
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [facebookUrl, setFacebookUrl] = useState("");
  const [threadsUrl, setThreadsUrl] = useState("");

  // UI state
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [saveMessageType, setSaveMessageType] = useState<"success" | "error">("success");
  const [savedUsername, setSavedUsername] = useState<string | null>(null);
  const [showBscModal, setShowBscModal] = useState(false);
  const [showMySlabsModal, setShowMySlabsModal] = useState(false);

  // The save result renders BELOW the Save button. Since NEO-128 split /profile
  // into a route per section, that button is the last element on its own page,
  // so the confirmation lands just past the bottom of the viewport: you click
  // Save and nothing appears to happen. (On the old single-page /profile the
  // section had three more below it, so the message was mid-document and
  // visible.) Bring it into view when it appears — `html { scroll-padding-top:
  // 80px }` in globals.css keeps it clear of the sticky binder header.
  const saveMessageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (saveMessage) {
      // "center", not "nearest": `nearest` does the minimum scroll, which lands
      // the message flush against the bottom edge (measured: bottom === the
      // viewport height exactly, zero margin). That is the same knife-edge that
      // made the credential buttons unreliable to tap at y=594 of 629.
      saveMessageRef.current?.scrollIntoView({ block: "center" });
    }
  }, [saveMessage]);

  // Username availability
  const debouncedUsername = useDebounce(username, 400);
  const usernameAvailable = useQuery(
    api.publicProfile.checkUsernameAvailable,
    debouncedUsername.length > 0 ? { username: debouncedUsername } : "skip"
  );

  // Convex hooks
  const upsertPublicProfile = useMutation(api.publicProfile.upsertPublicProfile);
  const uploadProfilePhoto = useAction(api.adapters.gcs.uploadProfilePhoto);

  /**
   * NEO-39/41 — has the operator touched the form since it was hydrated?
   *
   * This component is both a live view of `getMyPublicProfile` AND an editor
   * for it, which is the reactive-form race the whole NEO-39 line is about.
   * The hydration effect below used to run on EVERY re-emit of that query and
   * blindly reset all 20 fields — and `useQuery` hands back a fresh object on
   * every reactive push, not only when the row's contents actually change. So
   * any push (this component's own save completing, a concurrent edit, an
   * unrelated reactivity wave) wiped whatever the operator was part-way
   * through typing.
   *
   * A ref, not state: it must update synchronously inside onChange without
   * scheduling a render, exactly like the focus-guard refs in
   * `useReactiveField`. Once set it is never cleared — after the first edit the
   * form belongs to the operator for the rest of the mount, and the server has
   * nothing to tell it that it does not already know (what we would re-hydrate
   * from is what we just sent; `upsertPublicProfile` does not normalise).
   */
  const dirtyRef = useRef(false);
  const markDirty = useCallback(() => {
    dirtyRef.current = true;
  }, []);

  // Populate form from existing profile — but only while it is still pristine.
  useEffect(() => {
    if (existingProfile && !dirtyRef.current) {
      setUsername(existingProfile.username ?? "");
      setDisplayName(existingProfile.displayName ?? "");
      setTagline(existingProfile.tagline ?? "");
      setBrandColor1(existingProfile.brandColor1 ?? "#00D558");
      setBrandColor2(existingProfile.brandColor2 ?? "#A44AFF");
      setEbayUrl(existingProfile.ebayUrl ?? "");
      setBuySportsCardsUrl(existingProfile.buySportsCardsUrl ?? "");
      setSportlotsUrl(existingProfile.sportlotsUrl ?? "");
      setMySlabsUrl(existingProfile.mySlabsUrl ?? "");
      setMyCardPostUrl(existingProfile.myCardPostUrl ?? "");
      setPaypalUsername(existingProfile.paypalUsername ?? "");
      setPaypalEmail(existingProfile.paypalEmail ?? "");
      setVenmoUsername(existingProfile.venmoUsername ?? "");
      setCashAppUsername(existingProfile.cashAppUsername ?? "");
      setTwitterUrl(existingProfile.twitterUrl ?? "");
      setInstagramUrl(existingProfile.instagramUrl ?? "");
      setTiktokUrl(existingProfile.tiktokUrl ?? "");
      setYoutubeUrl(existingProfile.youtubeUrl ?? "");
      setFacebookUrl(existingProfile.facebookUrl ?? "");
      setThreadsUrl(existingProfile.threadsUrl ?? "");
      if (existingProfile.photoUrl) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- NEO-41 hydration effect; already guarded by dirtyRef so a reactive push cannot stomp an edit in progress
        setPhotoPreview(existingProfile.photoUrl);
      }
      setSavedUsername(existingProfile.username ?? null);
    }
  }, [existingProfile]);

  const handleUsernameChange = useCallback(
    (value: string) => {
      markDirty();
      const sanitized = value.toLowerCase().replace(/[^a-z0-9-]/g, "");
      setUsername(sanitized);
    },
    [markDirty],
  );

  /**
   * Every field routes its edit through here so one call site owns the
   * dirty-marking. A setter wired straight to onChange would silently opt that
   * one field out of the guard and reintroduce the stomp for it alone.
   */
  const edit = useCallback(
    <T,>(setter: (v: T) => void) =>
      (value: T) => {
        markDirty();
        setter(value);
      },
    [markDirty],
  );

  const handlePhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    markDirty();
    const reader = new FileReader();
    reader.onload = (ev) => {
      const result = ev.target?.result as string;
      setStagedPhotoBase64(result);
      setPhotoPreview(result);
    };
    reader.readAsDataURL(file);
  };

  const handleSave = async () => {
    if (!username) {
      setSaveMessage("Username is required.");
      setSaveMessageType("error");
      return;
    }
    if (!/^[a-z0-9-]+$/.test(username)) {
      setSaveMessage("Username may only contain lowercase letters, numbers, and hyphens.");
      setSaveMessageType("error");
      return;
    }

    setIsSaving(true);
    setSaveMessage("");

    try {
      let photoUrl: string | undefined;

      // Upload staged photo if present
      if (stagedPhotoBase64) {
        const uploadResult = await uploadProfilePhoto({ imageBase64: stagedPhotoBase64 });
        if (uploadResult.success && uploadResult.imageUrl) {
          // Vercel Blob upload successful
          photoUrl = uploadResult.imageUrl;
        } else if (uploadResult.message === "Vercel Blob storage not configured") {
          // Fallback to base64 data URL if Vercel Blob is not configured
          photoUrl = stagedPhotoBase64;
        } else {
          throw new Error(uploadResult.message);
        }
      }

      await upsertPublicProfile({
        username,
        displayName: displayName || undefined,
        photoUrl: photoUrl ?? (existingProfile?.photoUrl || undefined),
        tagline: tagline || undefined,
        brandColor1: brandColor1 || undefined,
        brandColor2: brandColor2 || undefined,
        ebayUrl: ebayUrl || undefined,
        buySportsCardsUrl: buySportsCardsUrl || undefined,
        sportlotsUrl: sportlotsUrl || undefined,
        mySlabsUrl: mySlabsUrl || undefined,
        myCardPostUrl: myCardPostUrl || undefined,
        paypalUsername: paypalUsername || undefined,
        paypalEmail: paypalEmail || undefined,
        venmoUsername: venmoUsername || undefined,
        cashAppUsername: cashAppUsername || undefined,
        twitterUrl: twitterUrl || undefined,
        instagramUrl: instagramUrl || undefined,
        tiktokUrl: tiktokUrl || undefined,
        youtubeUrl: youtubeUrl || undefined,
        facebookUrl: facebookUrl || undefined,
        threadsUrl: threadsUrl || undefined,
      });

      setSavedUsername(username);
      setSaveMessage("Profile saved!");
      setSaveMessageType("success");
      setStagedPhotoBase64(null);
    } catch (error) {
      setSaveMessage(error instanceof Error ? error.message : "Failed to save profile.");
      setSaveMessageType("error");
    } finally {
      setIsSaving(false);
    }
  };

  // Geometry only — surface, border, radius and focus ring now come from the
  // shared Input primitive (NEO-44), which in `bare` mode deliberately emits no
  // layout classes so the row keeps the exact dimensions it always had.
  const inputClass = "w-full px-3 py-2";

  const labelClass = "block text-sm font-medium mb-1 text-ink-2";

  const isOwnUsername = existingProfile?.username === debouncedUsername;
  const showAvailability = debouncedUsername.length > 0 && !isOwnUsername;

  // URL inference functions
  const inferredUrls = {
    ebay: () => `https://www.ebay.com/str/${username}`,
    buySportsCards: () => `https://www.buysportscards.com/sellers/${username}`,
    sportlots: () => `https://sportlots.com/dealers/?dealer=${username}`,
    mySlabs: () => `https://www.myslabs.com/${username}`,
    myCardPost: () => `https://www.mycardpost.com/${username}`,
    twitter: () => `https://x.com/${username}`,
    instagram: () => `https://www.instagram.com/${username}`,
    tiktok: () => `https://www.tiktok.com/@${username}`,
    youtube: () => `https://www.youtube.com/@${username}`,
    facebook: () => `https://www.facebook.com/${username}`,
    threads: () => `https://www.threads.net/@${username}`,
    paypal: () => `paypal.me/${username}`,
    venmo: () => `venmo.com/${username}`,
    cashApp: () => `cash.app/${username}`,
  };

  const canInferUrl = username.length > 0;

  /**
   * NEO-260 — every `pub-*` id below is LABEL WIRING, not a test handle.
   *
   * Each field renders a visible `<label htmlFor="pub-…">` and the shared
   * `Input` primitive is in `bare` mode, so it emits only the `<input>`: the
   * explicit id is the only thing associating the two. Delete an id and the
   * label stops naming its field for a screen reader and stops focusing it on
   * click — which is also how a person, and the profile Maestro flows, reach
   * these inputs (tap the visible label, then type).
   *
   * The flows deliberately target the LABEL TEXT, never these ids: a DOM id is
   * invisible to a sighted user and to a screen reader alike, so a flow that
   * targets one can pass while the real experience is broken. Keeping the id
   * has a second payoff for those flows — maestro-web re-finds the focused
   * element by `createXPathFromElement`, which prefers `id("…")`, so every
   * keystroke lands in the field the label just focused.
   *
   * Rule of thumb when editing this file: add a visible `<label htmlFor>` +
   * matching id for a new field, and use `aria-label` only where the design
   * has no visible label (the two brand hex boxes above).
   */

  return (
    <div className="space-y-8">
      {/* Basic Info */}
      <div className="space-y-4">
        <h3 className="font-semibold text-ink-2">Basic Info</h3>

        {/* Username */}
        <div>
          <label htmlFor="pub-username" className={labelClass}>
            Username <span className="text-ink-3 text-xs">(neonbinder.com/u/username)</span>
          </label>
          <div className="relative">
            <Input
              bare
              id="pub-username"
              type="text"
              value={username}
              onChange={(e) => handleUsernameChange(e.target.value)}
              className={inputClass}
              placeholder="e.g. coolcardcollector"
              autoComplete="off"
              data-lpignore="true"
              data-1p-ignore
              data-form-type="other"
            />
            {showAvailability && (
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium">
                {usernameAvailable === undefined ? (
                  <span className="text-ink-3">checking…</span>
                ) : usernameAvailable ? (
                  <span className="text-neon-blue-text">available</span>
                ) : (
                  <span className="text-neon-pink-text">taken</span>
                )}
              </span>
            )}
          </div>
        </div>

        <div>
          <label htmlFor="pub-display-name" className={labelClass}>
            Display Name
          </label>
          <Input
            bare
            id="pub-display-name"
            type="text"
            value={displayName}
            onChange={(e) => edit(setDisplayName)(e.target.value)}
            className={inputClass}
            placeholder="Your name or shop name"
          />
        </div>

        <div>
          <label htmlFor="pub-tagline" className={labelClass}>
            Tagline
          </label>
          <Input
            bare
            id="pub-tagline"
            type="text"
            value={tagline}
            onChange={(e) => edit(setTagline)(e.target.value)}
            className={inputClass}
            placeholder="e.g. Vintage baseball cards & rare finds"
          />
        </div>
      </div>

      {/* Profile Photo */}
      <div className="space-y-3">
        <h3 className="font-semibold text-ink-2">Profile Photo</h3>
        <div className="flex items-center gap-4">
          {photoPreview ? (
            <img
              src={photoPreview}
              alt="Profile preview"
              className="w-20 h-20 rounded-full object-cover border-2 border-rule-strong"
            />
          ) : (
            <div className="w-20 h-20 rounded-full bg-raised border-2 border-rule-strong flex items-center justify-center text-ink-3 text-2xl">
              ?
            </div>
          )}
          <div>
            <input
              ref={fileInputRef}
              id="pub-photo-input"
              type="file"
              accept="image/*"
              onChange={handlePhotoChange}
              className="peer sr-only"
            />
            <label
              htmlFor="pub-photo-input"
              className="inline-block cursor-pointer px-4 py-2 rounded-md bg-raised border border-rule-strong text-sm text-ink-2 hover:bg-hover-raised transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus"
            >
              Choose photo
            </label>
            {stagedPhotoBase64 && (
              <p className="text-xs text-ink-3 mt-1">Photo staged — will upload on save</p>
            )}
          </div>
        </div>
      </div>

      {/* Brand Colors */}
      <div className="space-y-3">
        <h3 className="font-semibold text-ink-2">Brand Colors</h3>
        <div className="flex flex-col sm:flex-row gap-6">
          <div className="flex items-center gap-3">
            <input
              type="color"
              value={brandColor1}
              onChange={(e) => edit(setBrandColor1)(e.target.value)}
              className="w-10 h-10 rounded cursor-pointer border border-rule-strong bg-transparent"
              aria-label="Brand color 1"
            />
            <Input
              bare
              type="text"
              value={brandColor1}
              onChange={(e) => edit(setBrandColor1)(e.target.value)}
              className="w-28 px-2 py-1 text-sm font-mono text-ink-2"
              placeholder="#00D558"
              aria-label="Brand hex code 1"
            />
          </div>
          <div className="flex items-center gap-3">
            <input
              type="color"
              value={brandColor2}
              onChange={(e) => edit(setBrandColor2)(e.target.value)}
              className="w-10 h-10 rounded cursor-pointer border border-rule-strong bg-transparent"
              aria-label="Brand color 2"
            />
            <Input
              bare
              type="text"
              value={brandColor2}
              onChange={(e) => edit(setBrandColor2)(e.target.value)}
              className="w-28 px-2 py-1 text-sm font-mono text-ink-2"
              placeholder="#A44AFF"
              aria-label="Brand hex code 2"
            />
          </div>
        </div>
        {/* Gradient preview strip */}
        <div
          className="h-8 rounded-md w-full"
          style={{ background: `linear-gradient(135deg, ${brandColor1}, ${brandColor2})` }}
          // role="img" so the label names something: aria-label on a bare div
          // is prohibited (axe aria-prohibited-attr) and is never announced.
          role="img"
          aria-label="Gradient preview"
        />
      </div>

      {/* Marketplace Links */}
      <div className="space-y-4">
        <h3 className="font-semibold text-ink-2">Marketplace Links</h3>
        {[
          { id: "pub-ebay", label: "eBay Store URL", value: ebayUrl, setter: setEbayUrl, placeholder: "https://www.ebay.com/str/yourstore", inferKey: "ebay" as const, buttonType: "fill" },
          { id: "pub-bsc", label: "BuySportsCards URL", value: buySportsCardsUrl, setter: setBuySportsCardsUrl, placeholder: "https://www.buysportscards.com/sellers/...", inferKey: "buySportsCards" as const, buttonType: "bsc" },
          { id: "pub-sportlots", label: "Sportlots URL", value: sportlotsUrl, setter: setSportlotsUrl, placeholder: "https://www.sportlots.com/...", inferKey: "sportlots" as const, buttonType: "fill" },
          { id: "pub-myslabs", label: "MySlabs URL", value: mySlabsUrl, setter: setMySlabsUrl, placeholder: "https://www.myslabs.com/...", inferKey: "mySlabs" as const, buttonType: "myslabs" },
          { id: "pub-mycardpost", label: "MyCardPost URL", value: myCardPostUrl, setter: setMyCardPostUrl, placeholder: "https://www.mycardpost.com/...", inferKey: "myCardPost" as const, buttonType: "fill" },
        ].map(({ id, label, value, setter, placeholder, inferKey, buttonType }) => (
          <div key={id}>
            <div className="flex items-center justify-between mb-1">
              <label htmlFor={id} className={labelClass}>{label}</label>
              {buttonType === "bsc" ? (
                <BscButton onClick={() => setShowBscModal(true)} />
              ) : buttonType === "myslabs" ? (
                <MySlabsButton onClick={() => setShowMySlabsModal(true)} />
              ) : (
                <FillButton onClick={() => edit(setter)(inferredUrls[inferKey]())} url={inferredUrls[inferKey]()} canInfer={canInferUrl} />
              )}
            </div>
            <Input
              bare
              id={id}
              type="url"
              value={value}
              onChange={(e) => edit(setter)(e.target.value)}
              className={inputClass}
              placeholder={placeholder}
            />
          </div>
        ))}
      </div>

      {/* Payment Handles */}
      <div className="space-y-4">
        <h3 className="font-semibold text-ink-2">Payment Handles</h3>
        <div>
          <div className="flex items-center justify-between mb-1">
            <label htmlFor="pub-paypal" className={labelClass}>
              PayPal username (Friends & Family){" "}
              {paypalUsername && (
                <span className="text-ink-3 text-xs">→ paypal.me/{paypalUsername}</span>
              )}
            </label>
            <FillButton onClick={() => edit(setPaypalUsername)(username)} url={inferredUrls.paypal()} canInfer={canInferUrl} />
          </div>
          <Input
            bare
            id="pub-paypal"
            type="text"
            value={paypalUsername}
            onChange={(e) => edit(setPaypalUsername)(e.target.value)}
            className={inputClass}
            placeholder="yourpaypalname"
          />
        </div>
        <div>
          <label htmlFor="pub-paypal-email" className={labelClass}>
            PayPal email (Goods & Services){" "}
            <span className="text-ink-3 text-xs">Buyer-protected payments</span>
          </label>
          <Input
            bare
            id="pub-paypal-email"
            type="email"
            value={paypalEmail}
            onChange={(e) => edit(setPaypalEmail)(e.target.value)}
            className={inputClass}
            placeholder="your@email.com"
          />
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <label htmlFor="pub-venmo" className={labelClass}>
              Venmo username{" "}
              {venmoUsername && (
                <span className="text-ink-3 text-xs">→ venmo.com/{venmoUsername}</span>
              )}
            </label>
            <FillButton onClick={() => edit(setVenmoUsername)(username)} url={inferredUrls.venmo()} canInfer={canInferUrl} />
          </div>
          <Input
            bare
            id="pub-venmo"
            type="text"
            value={venmoUsername}
            onChange={(e) => edit(setVenmoUsername)(e.target.value)}
            className={inputClass}
            placeholder="yourvenmoname"
          />
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <label htmlFor="pub-cashapp" className={labelClass}>
              Cash App username{" "}
              {cashAppUsername && (
                <span className="text-ink-3 text-xs">→ cash.app/${cashAppUsername}</span>
              )}
            </label>
            <FillButton onClick={() => edit(setCashAppUsername)(username)} url={inferredUrls.cashApp()} canInfer={canInferUrl} />
          </div>
          <Input
            bare
            id="pub-cashapp"
            type="text"
            value={cashAppUsername}
            onChange={(e) => edit(setCashAppUsername)(e.target.value)}
            className={inputClass}
            placeholder="yourcashapptag"
          />
        </div>
      </div>

      {/* Social Media */}
      <div className="space-y-4">
        <h3 className="font-semibold text-ink-2">Social Media</h3>
        {[
          { id: "pub-twitter", label: "Twitter / X URL", value: twitterUrl, setter: setTwitterUrl, placeholder: "https://x.com/yourhandle", inferKey: "twitter" as const },
          { id: "pub-instagram", label: "Instagram URL", value: instagramUrl, setter: setInstagramUrl, placeholder: "https://www.instagram.com/yourhandle", inferKey: "instagram" as const },
          { id: "pub-tiktok", label: "TikTok URL", value: tiktokUrl, setter: setTiktokUrl, placeholder: "https://www.tiktok.com/@yourhandle", inferKey: "tiktok" as const },
          { id: "pub-youtube", label: "YouTube URL", value: youtubeUrl, setter: setYoutubeUrl, placeholder: "https://www.youtube.com/@yourchannel", inferKey: "youtube" as const },
          { id: "pub-facebook", label: "Facebook URL", value: facebookUrl, setter: setFacebookUrl, placeholder: "https://www.facebook.com/yourpage", inferKey: "facebook" as const },
          { id: "pub-threads", label: "Threads URL", value: threadsUrl, setter: setThreadsUrl, placeholder: "https://www.threads.net/@yourhandle", inferKey: "threads" as const },
        ].map(({ id, label, value, setter, placeholder, inferKey }) => (
          <div key={id}>
            <div className="flex items-center justify-between mb-1">
              <label htmlFor={id} className={labelClass}>{label}</label>
              <FillButton onClick={() => edit(setter)(inferredUrls[inferKey]())} url={inferredUrls[inferKey]()} canInfer={canInferUrl} />
            </div>
            <Input
              bare
              id={id}
              type="url"
              value={value}
              onChange={(e) => edit(setter)(e.target.value)}
              className={inputClass}
              placeholder={placeholder}
            />
          </div>
        ))}
      </div>

      {/* Save */}
      <div>
        <NeonButton
          onClick={handleSave}
          disabled={isSaving}
          className="w-full"
        >
          {isSaving ? "Saving…" : "Save Public Profile"}
        </NeonButton>

        {saveMessage && (
          <div
            ref={saveMessageRef}
            className={`mt-8 p-3 rounded-md text-sm ${
              saveMessageType === "success"
                ? "bg-neon-purple/10 text-neon-purple-text border border-neon-purple/40"
                : "bg-notice-danger-bg text-notice-danger-ink border border-notice-danger-rule"
            }`}
          >
            {saveMessage}
            {saveMessageType === "success" && savedUsername && (
              <>
                {" "}
                <a
                  href={`/u/${savedUsername}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline font-medium"
                >
                  View your profile at /u/{savedUsername}
                </a>
              </>
            )}
          </div>
        )}
      </div>

      {showBscModal && (
        <MarketplaceUrlHelpDialog
          title="Find Your BuySportsCards Seller URL"
          intro="To find your BuySportsCards seller URL:"
          steps={[
            "Visit BuySportsCards sellers page",
            "Navigate to your seller profile",
            'Click the "Share Seller" button',
            "Copy the URL from the share dialog",
            "Paste it into the field above",
          ]}
          openHref="https://www.buysportscards.com/sellers"
          openLabel="Open BuySportsCards"
          onClose={() => setShowBscModal(false)}
        />
      )}

      {showMySlabsModal && (
        <MarketplaceUrlHelpDialog
          title="Find Your MySlabs URL"
          intro="To find your MySlabs URL:"
          steps={[
            "Go to your MySlabs account settings",
            "Scroll to the bottom of the page",
            "Find your profile URL",
            "Copy the URL",
            "Paste it into the field above",
          ]}
          openHref="https://www.myslabs.com/account/"
          openLabel="Open MySlabs Account"
          onClose={() => setShowMySlabsModal(false)}
        />
      )}
    </div>
  );
}

interface MarketplaceUrlHelpDialogProps {
  title: string;
  intro: string;
  steps: string[];
  openHref: string;
  openLabel: string;
  onClose: () => void;
}

/**
 * "Where do I find this URL?" help for the BSC and MySlabs fields.
 *
 * These were two plain fixed `<div>`s: no dialog role, no Escape, and focus
 * stayed on the ? button behind the overlay, so a keyboard or screen-reader
 * user opened something they could neither find nor dismiss (SC 2.4.3, 4.1.2).
 * Same keyboard contract as `ConfirmDialog`: focus opens on Close, Escape
 * closes, Tab is trapped, and focus returns to the opener.
 */
function MarketplaceUrlHelpDialog({
  title,
  intro,
  steps,
  openHref,
  openLabel,
  onClose,
}: MarketplaceUrlHelpDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => {
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>("a[href], button:not([disabled])") ?? [],
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 bg-scrim flex items-center justify-center z-50 p-4"
      onClick={onClose}
      onKeyDown={handleKeyDown}
    >
      <div className="bg-field border border-rule-strong rounded-lg p-6 max-w-md w-full shadow-offset" onClick={(e) => e.stopPropagation()}>
        <h3 id={titleId} className="text-lg font-semibold text-ink-2 mb-3">{title}</h3>
        <p className="text-sm text-ink-3 mb-4">{intro}</p>
        <ol className="text-sm text-ink-3 space-y-2 mb-6 list-decimal list-inside">
          {steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <div className="flex gap-3">
          <a
            href={openHref}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 inline-flex items-center justify-center text-center px-4 py-2 rounded-md bg-neon-blue text-on-neon-blue font-medium hover:bg-neon-blue-hover transition-colors focus-outline"
          >
            {openLabel}
          </a>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="flex-1 px-4 py-2 rounded-md bg-button-neutral text-ink-2 font-medium hover:bg-button-neutral-hover transition-colors focus-outline"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
