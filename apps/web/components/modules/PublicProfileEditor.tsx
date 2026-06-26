/* eslint-disable @next/next/no-img-element */
"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import NeonButton from "./NeonButton";

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
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

  // Username availability
  const debouncedUsername = useDebounce(username, 400);
  const usernameAvailable = useQuery(
    api.publicProfile.checkUsernameAvailable,
    debouncedUsername.length > 0 ? { username: debouncedUsername } : "skip"
  );

  // Convex hooks
  const upsertPublicProfile = useMutation(api.publicProfile.upsertPublicProfile);
  const uploadProfilePhoto = useAction(api.adapters.gcs.uploadProfilePhoto);

  // Populate form from existing profile
  useEffect(() => {
    if (existingProfile) {
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
        setPhotoPreview(existingProfile.photoUrl);
      }
      setSavedUsername(existingProfile.username ?? null);
    }
  }, [existingProfile]);

  const handleUsernameChange = useCallback((value: string) => {
    const sanitized = value.toLowerCase().replace(/[^a-z0-9-]/g, "");
    setUsername(sanitized);
  }, []);

  const handlePhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
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

  const inputClass =
    "w-full px-3 py-2 border border-slate-700 rounded-md bg-slate-900 text-foreground focus:outline-none focus:ring-2 focus:ring-[#00C2FF]";

  const labelClass = "block text-sm font-medium mb-1 text-slate-300";

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

  const FillButton = ({ onClick, url }: { onClick: () => void; url: string }) => (
    <button
      onClick={onClick}
      disabled={!canInferUrl}
      className="text-xs text-[#00C2FF] hover:text-[#00C2FF]/80 disabled:text-slate-500 disabled:cursor-not-allowed transition-colors break-all text-right"
      title={canInferUrl ? "Click to fill with inferred URL" : "Enter a username first"}
    >
      {url}
    </button>
  );

  const BscButton = () => (
    <button
      onClick={() => setShowBscModal(true)}
      className="text-xs text-[#00C2FF] hover:text-[#00C2FF]/80 transition-colors"
    >
      Find my BSC url
    </button>
  );

  const MySlabsButton = () => (
    <button
      onClick={() => setShowMySlabsModal(true)}
      className="text-xs text-[#00C2FF] hover:text-[#00C2FF]/80 transition-colors"
    >
      Find my MySlabs url
    </button>
  );

  return (
    <div className="space-y-8">
      {/* Basic Info */}
      <div className="space-y-4">
        <h3 className="font-semibold text-slate-200">Basic Info</h3>

        {/* Username */}
        <div>
          <label htmlFor="pub-username" className={labelClass}>
            Username <span className="text-slate-500 text-xs">(neonbinder.com/u/username)</span>
          </label>
          <div className="relative">
            <input
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
                  <span className="text-slate-400">checking…</span>
                ) : usernameAvailable ? (
                  <span className="text-[#00C2FF]">available</span>
                ) : (
                  <span className="text-[#FF2EB3]">taken</span>
                )}
              </span>
            )}
          </div>
        </div>

        <div>
          <label htmlFor="pub-display-name" className={labelClass}>
            Display Name
          </label>
          <input
            id="pub-display-name"
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className={inputClass}
            placeholder="Your name or shop name"
          />
        </div>

        <div>
          <label htmlFor="pub-tagline" className={labelClass}>
            Tagline
          </label>
          <input
            id="pub-tagline"
            type="text"
            value={tagline}
            onChange={(e) => setTagline(e.target.value)}
            className={inputClass}
            placeholder="e.g. Vintage baseball cards & rare finds"
          />
        </div>
      </div>

      {/* Profile Photo */}
      <div className="space-y-3">
        <h3 className="font-semibold text-slate-200">Profile Photo</h3>
        <div className="flex items-center gap-4">
          {photoPreview ? (
            <img
              src={photoPreview}
              alt="Profile photo preview"
              className="w-20 h-20 rounded-full object-cover border-2 border-slate-700"
            />
          ) : (
            <div className="w-20 h-20 rounded-full bg-slate-800 border-2 border-slate-700 flex items-center justify-center text-slate-500 text-2xl">
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
              className="hidden"
            />
            <label
              htmlFor="pub-photo-input"
              className="cursor-pointer px-4 py-2 rounded-md bg-slate-800 border border-slate-700 text-sm text-slate-300 hover:bg-slate-700 transition-colors"
            >
              Choose photo
            </label>
            {stagedPhotoBase64 && (
              <p className="text-xs text-slate-400 mt-1">Photo staged — will upload on save</p>
            )}
          </div>
        </div>
      </div>

      {/* Brand Colors */}
      <div className="space-y-3">
        <h3 className="font-semibold text-slate-200">Brand Colors</h3>
        <div className="flex flex-col sm:flex-row gap-6">
          <div className="flex items-center gap-3">
            <input
              type="color"
              value={brandColor1}
              onChange={(e) => setBrandColor1(e.target.value)}
              className="w-10 h-10 rounded cursor-pointer border border-slate-700 bg-transparent"
              aria-label="Brand color 1"
            />
            <input
              type="text"
              value={brandColor1}
              onChange={(e) => setBrandColor1(e.target.value)}
              className="w-28 px-2 py-1 border border-slate-700 rounded bg-slate-900 text-sm font-mono text-slate-300 focus:outline-none focus:ring-2 focus:ring-[#00C2FF]"
              placeholder="#00D558"
            />
          </div>
          <div className="flex items-center gap-3">
            <input
              type="color"
              value={brandColor2}
              onChange={(e) => setBrandColor2(e.target.value)}
              className="w-10 h-10 rounded cursor-pointer border border-slate-700 bg-transparent"
              aria-label="Brand color 2"
            />
            <input
              type="text"
              value={brandColor2}
              onChange={(e) => setBrandColor2(e.target.value)}
              className="w-28 px-2 py-1 border border-slate-700 rounded bg-slate-900 text-sm font-mono text-slate-300 focus:outline-none focus:ring-2 focus:ring-[#00C2FF]"
              placeholder="#A44AFF"
            />
          </div>
        </div>
        {/* Gradient preview strip */}
        <div
          className="h-8 rounded-md w-full"
          style={{ background: `linear-gradient(135deg, ${brandColor1}, ${brandColor2})` }}
          aria-label="Gradient preview"
        />
      </div>

      {/* Marketplace Links */}
      <div className="space-y-4">
        <h3 className="font-semibold text-slate-200">Marketplace Links</h3>
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
                <BscButton />
              ) : buttonType === "myslabs" ? (
                <MySlabsButton />
              ) : (
                <FillButton onClick={() => setter(inferredUrls[inferKey]())} url={inferredUrls[inferKey]()} />
              )}
            </div>
            <input
              id={id}
              type="url"
              value={value}
              onChange={(e) => setter(e.target.value)}
              className={inputClass}
              placeholder={placeholder}
            />
          </div>
        ))}
      </div>

      {/* Payment Handles */}
      <div className="space-y-4">
        <h3 className="font-semibold text-slate-200">Payment Handles</h3>
        <div>
          <div className="flex items-center justify-between mb-1">
            <label htmlFor="pub-paypal" className={labelClass}>
              PayPal username (Friends & Family){" "}
              {paypalUsername && (
                <span className="text-slate-500 text-xs">→ paypal.me/{paypalUsername}</span>
              )}
            </label>
            <FillButton onClick={() => setPaypalUsername(username)} url={inferredUrls.paypal()} />
          </div>
          <input
            id="pub-paypal"
            type="text"
            value={paypalUsername}
            onChange={(e) => setPaypalUsername(e.target.value)}
            className={inputClass}
            placeholder="yourpaypalname"
          />
        </div>
        <div>
          <label htmlFor="pub-paypal-email" className={labelClass}>
            PayPal email (Goods & Services){" "}
            <span className="text-slate-500 text-xs">Buyer-protected payments</span>
          </label>
          <input
            id="pub-paypal-email"
            type="email"
            value={paypalEmail}
            onChange={(e) => setPaypalEmail(e.target.value)}
            className={inputClass}
            placeholder="your@email.com"
          />
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <label htmlFor="pub-venmo" className={labelClass}>
              Venmo username{" "}
              {venmoUsername && (
                <span className="text-slate-500 text-xs">→ venmo.com/{venmoUsername}</span>
              )}
            </label>
            <FillButton onClick={() => setVenmoUsername(username)} url={inferredUrls.venmo()} />
          </div>
          <input
            id="pub-venmo"
            type="text"
            value={venmoUsername}
            onChange={(e) => setVenmoUsername(e.target.value)}
            className={inputClass}
            placeholder="yourvenmoname"
          />
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <label htmlFor="pub-cashapp" className={labelClass}>
              Cash App username{" "}
              {cashAppUsername && (
                <span className="text-slate-500 text-xs">→ cash.app/${cashAppUsername}</span>
              )}
            </label>
            <FillButton onClick={() => setCashAppUsername(username)} url={inferredUrls.cashApp()} />
          </div>
          <input
            id="pub-cashapp"
            type="text"
            value={cashAppUsername}
            onChange={(e) => setCashAppUsername(e.target.value)}
            className={inputClass}
            placeholder="yourcashapptag"
          />
        </div>
      </div>

      {/* Social Media */}
      <div className="space-y-4">
        <h3 className="font-semibold text-slate-200">Social Media</h3>
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
              <FillButton onClick={() => setter(inferredUrls[inferKey]())} url={inferredUrls[inferKey]()} />
            </div>
            <input
              id={id}
              type="url"
              value={value}
              onChange={(e) => setter(e.target.value)}
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
            className={`mt-8 p-3 rounded-md text-sm ${
              saveMessageType === "success"
                ? "bg-purple-900/30 text-purple-300 border border-purple-800"
                : "bg-red-900/30 text-red-300 border border-red-800"
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

      {/* BSC Modal */}
      {showBscModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setShowBscModal(false)}>
          <div className="bg-slate-900 border border-slate-700 rounded-lg p-6 max-w-md w-full" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-slate-200 mb-3">Find Your BuySportsCards Seller URL</h3>
            <p className="text-sm text-slate-400 mb-4">
              To find your BuySportsCards seller URL:
            </p>
            <ol className="text-sm text-slate-400 space-y-2 mb-6 list-decimal list-inside">
              <li>Visit BuySportsCards sellers page</li>
              <li>Navigate to your seller profile</li>
              <li>Click the &quot;Share Seller&quot; button</li>
              <li>Copy the URL from the share dialog</li>
              <li>Paste it into the field above</li>
            </ol>
            <div className="flex gap-3">
              <button
                onClick={() => {
                  window.open("https://www.buysportscards.com/sellers", "_blank");
                }}
                className="flex-1 px-4 py-2 rounded-md bg-[#00C2FF] text-black font-medium hover:bg-[#00C2FF]/90 transition-colors"
              >
                Open BuySportsCards
              </button>
              <button
                onClick={() => setShowBscModal(false)}
                className="flex-1 px-4 py-2 rounded-md bg-slate-700 text-slate-200 font-medium hover:bg-slate-600 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MySlabs Modal */}
      {showMySlabsModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setShowMySlabsModal(false)}>
          <div className="bg-slate-900 border border-slate-700 rounded-lg p-6 max-w-md w-full" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-slate-200 mb-3">Find Your MySlabs URL</h3>
            <p className="text-sm text-slate-400 mb-4">
              To find your MySlabs URL:
            </p>
            <ol className="text-sm text-slate-400 space-y-2 mb-6 list-decimal list-inside">
              <li>Go to your MySlabs account settings</li>
              <li>Scroll to the bottom of the page</li>
              <li>Find your profile URL</li>
              <li>Copy the URL</li>
              <li>Paste it into the field above</li>
            </ol>
            <div className="flex gap-3">
              <button
                onClick={() => {
                  window.open("https://www.myslabs.com/account/", "_blank");
                }}
                className="flex-1 px-4 py-2 rounded-md bg-[#00C2FF] text-black font-medium hover:bg-[#00C2FF]/90 transition-colors"
              >
                Open MySlabs Account
              </button>
              <button
                onClick={() => setShowMySlabsModal(false)}
                className="flex-1 px-4 py-2 rounded-md bg-slate-700 text-slate-200 font-medium hover:bg-slate-600 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
