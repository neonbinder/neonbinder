import { useState, useEffect, useRef } from "react";
import { useMutation, useAction, useQuery } from "convex/react";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import NeonButton from "../../components/modules/NeonButton";
import PublicProfileEditor from "../../components/modules/PublicProfileEditor";

const SUPPORTED_SITES = [
  { key: "buysportscards", label: "BuySportsCards" },
  { key: "sportlots", label: "Sportlots" },
  // Add more sites here as needed (eBay coming soon)
];

export default function ProfilePage() {
  const [selectedSite, setSelectedSite] = useState(SUPPORTED_SITES[0].key);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [messageDetails, setMessageDetails] = useState<string | undefined>(
    undefined,
  );
  const [messageType, setMessageType] = useState<"success" | "error">(
    "success",
  );
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);

  // Refs for clear-confirm modal focus management (2.4.3 Focus Order, 2.1.1 Keyboard)
  const clearTriggerRef = useRef<HTMLElement | null>(null);
  const clearCancelButtonRef = useRef<HTMLButtonElement>(null);
  const clearDialogRef = useRef<HTMLDivElement>(null);

  // Prize Pool state
  const [newPrizeName, setNewPrizeName] = useState("");
  const [newPrizePercentage, setNewPrizePercentage] = useState("");
  const [newPokemonImage, setNewPokemonImage] = useState<string | null>(null);
  const [newPokemonImagePreview, setNewPokemonImagePreview] = useState<
    string | null
  >(null);
  const [newSportsImages, setNewSportsImages] = useState<string[]>([]);
  const [newSportsImagePreviews, setNewSportsImagePreviews] = useState<
    string[]
  >([]);
  const [editingPrizeId, setEditingPrizeId] = useState<Id<"prizePool"> | null>(null);
  const [editPrizeName, setEditPrizeName] = useState("");
  const [editPrizePercentage, setEditPrizePercentage] = useState("");
  const [editPokemonImage, setEditPokemonImage] = useState<string | null>(null);
  const [editPokemonImagePreview, setEditPokemonImagePreview] = useState<
    string | null
  >(null);
  const [editSportsImages, setEditSportsImages] = useState<string[]>([]);
  const [editSportsImagePreviews, setEditSportsImagePreviews] = useState<
    string[]
  >([]);
  const [prizeMessage, setPrizeMessage] = useState("");
  const [prizeMessageType, setPrizeMessageType] = useState<"success" | "error">(
    "success",
  );
  const [isMounted, setIsMounted] = useState(false);
  const [pokemonDragActive, setPokemonDragActive] = useState(false);
  const [sportsDragActive, setSportsDragActive] = useState(false);

  // Actions and Mutations
  const storeCredentials = useAction(api.credentials.storeSiteCredentials);
  const updateCredentialStatus = useMutation(
    api.userProfile.updateSiteCredentialStatus,
  );
  const removeCredentialStatus = useMutation(
    api.userProfile.removeSiteCredentialStatus,
  );
  const deleteSiteCredentials = useAction(api.credentials.deleteSiteCredentials);
  const getSiteCredentials = useAction(api.credentials.getSiteCredentials);
  const testSiteCredentials = useAction(api.credentials.testSiteCredentials);
  // Prize Pool mutations and queries
  const createPrize = useMutation(api.userProfile.createPrize);
  const updatePrize = useMutation(api.userProfile.updatePrize);
  const deletePrize = useMutation(api.userProfile.deletePrize);
  const uploadPrizeImage = useAction(api.adapters.gcs.uploadPrizeImage);
  const prizes = useQuery(api.userProfile.getPrizes);

  // Get user profile to check if credentials are stored
  const profile = useQuery(api.userProfile.getUserProfile);
  const siteMeta = SUPPORTED_SITES.find((s) => s.key === selectedSite);

  // Feature flags for GCP-dependent features
  const isPrizeImagesEnabled = useFeatureFlagEnabled("prize-images-enabled");
  const hasStoredCredentials =
    profile?.siteCredentials?.some(
      (cred) => cred.site === selectedSite && cred.hasCredentials,
    ) || false;

  // Reactive in-flight guard. A credential op (store / test-login / delete)
  // holds a per-(user, site) lock on the backend, surfaced as `lockedAt` on the
  // profile. While ANY site has a LIVE lock, disable every credential control
  // AND the site tabs so a Clear can't race an in-flight marketplace login. The
  // backend release patches the row → this recomputes false (the disable lifts
  // on completion, not on lease expiry). Must be >= the server lease in
  // convex/userProfile.ts (CRED_LOCK_LEASE_MS); a stale lock (crashed op) is
  // ignored after the lease and reclaimed by the next op. `profile === undefined`
  // (loading) and legacy rows without the field read as not-busy.
  const CRED_LOCK_LEASE_MS = 5 * 60 * 1000;
  const anyCredentialOpInFlight =
    profile?.siteCredentials?.some(
      (cred) =>
        typeof cred.lockedAt === "number" &&
        cred.lockedAt + CRED_LOCK_LEASE_MS > Date.now(),
    ) || false;
  const credsBusy = isLoading || anyCredentialOpInFlight;

  // Set mounted flag after hydration
  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Reset form fields and edit mode when site changes
  useEffect(() => {
    setUsername("");
    setPassword("");
    setMessage("");
    setIsAuthenticated(false);
    setEditMode(false);
  }, [selectedSite]);

  // Check if credentials exist in Secret Manager for the selected site
  useEffect(() => {
    const check = async () => {
      if (!hasStoredCredentials) {
        setIsAuthenticated(false);
        return;
      }
      setIsLoading(true);
      try {
        const creds = await getSiteCredentials({ site: selectedSite });
        setIsAuthenticated(!!creds);
      } catch {
        // If the browser service is unreachable, trust the stored profile flag
        // rather than showing a confusing unauthenticated state
        setIsAuthenticated(true);
      } finally {
        setIsLoading(false);
      }
    };
    check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSite, hasStoredCredentials]);

  // Escape closes the clear-confirm modal (keyboard parity with the Cancel button).
  useEffect(() => {
    if (!confirmingClear) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !credsBusy) setConfirmingClear(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmingClear, credsBusy]);

  // Focus management for the clear-confirm modal: move focus into the Cancel button
  // on open (safe default for a destructive dialog), and return focus to the trigger
  // on close. WCAG 2.4.3 Focus Order requires focus to enter a dialog when it opens
  // and return to the invoking element when it closes.
  useEffect(() => {
    if (confirmingClear) {
      // rAF defers until after the browser has painted the dialog, avoiding a
      // VoiceOver timing edge case where focus lands before the node is visible.
      const raf = requestAnimationFrame(() => clearCancelButtonRef.current?.focus());
      return () => cancelAnimationFrame(raf);
    } else {
      clearTriggerRef.current?.focus();
      clearTriggerRef.current = null;
    }
  }, [confirmingClear]);

  const handleSaveCredentials = async () => {
    if (!username || !password) {
      setMessage("Please enter both username and password to save.");
      setMessageType("error");
      return;
    }
    setIsLoading(true);
    setMessage("");
    setMessageDetails(undefined);
    try {
      const secretResult = await storeCredentials({
        site: selectedSite,
        username,
        password,
      });
      if (!secretResult.success) {
        throw new Error(secretResult.message);
      }
      // Update user profile status
      await updateCredentialStatus({
        site: selectedSite,
        hasCredentials: true,
      });
      setPassword("");

      // Automatically verify credentials against the marketplace so the user
      // doesn't have to click Test Credentials separately. Keeps credentials
      // stored on auth failure so the user can retry without re-entering.
      const authResult = await testSiteCredentials({ site: selectedSite });
      if (authResult.success) {
        setMessage(
          `Credentials saved successfully! Your credentials have been securely encrypted and verified with ${siteMeta?.label}.`,
        );
        setMessageDetails(authResult.details);
        setMessageType("success");
        setIsAuthenticated(true);
      } else {
        setMessage(
          `Credentials were saved, but ${siteMeta?.label} authentication failed: ${authResult.message}. Use "Test Credentials" to retry once the issue is resolved.`,
        );
        setMessageDetails(authResult.details);
        setMessageType("error");
        setIsAuthenticated(false);
      }
    } catch (error) {
      setMessage(
        `Failed to save credentials: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
      setMessageType("error");
      setIsAuthenticated(false);
    } finally {
      setIsLoading(false);
    }
  };

  const handleTestCredentials = async () => {
    if (!hasStoredCredentials) {
      setMessage("Please save credentials first before testing.");
      setMessageType("error");
      setMessageDetails(undefined);
      return;
    }
    setIsLoading(true);
    setMessage(`Testing stored credentials with ${siteMeta?.label}...`);
    setMessageDetails(undefined);
    try {
      const testResult = await testSiteCredentials({ site: selectedSite });

      if (testResult.success) {
        setMessage(testResult.message);
        setMessageDetails(testResult.details);
        setMessageType("success");
        setIsAuthenticated(true);
      } else {
        setMessage(testResult.message);
        setMessageDetails(testResult.details);
        setMessageType("error");
        setIsAuthenticated(false);
      }
    } catch (error) {
      console.error("Error testing credentials:", error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      setMessage("Failed to test credentials. Please try again.");
      setMessageDetails(
        `An unexpected error occurred while testing credentials: ${errorMessage}`,
      );
      setMessageType("error");
      setIsAuthenticated(false);
    } finally {
      setIsLoading(false);
    }
  };

  const handleClearCredentials = () => {
    // Capture the trigger before opening so focus can be returned on close (WCAG 2.4.3).
    clearTriggerRef.current = document.activeElement as HTMLElement;
    setConfirmingClear(true);
  };

  // Focus trap for the clear-confirm modal. While the dialog is open, Tab and
  // Shift+Tab must cycle only within the dialog's focusable elements (WCAG 2.1.1,
  // WAI-ARIA Dialog Pattern).
  const handleClearModalKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const dialog = clearDialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const handleConfirmClear = async () => {
    setConfirmingClear(false);
    setIsLoading(true);
    setMessage("");
    try {
      const result = await deleteSiteCredentials({ site: selectedSite });
      if (!result.success) {
        // e.g. "Another credential operation is in progress — try again."
        setMessage(result.message);
        setMessageType("error");
        return;
      }
      await removeCredentialStatus({ site: selectedSite });
      setUsername("");
      setPassword("");
      setIsAuthenticated(false);
      setMessage("Credentials cleared successfully!");
      setMessageType("success");
    } catch {
      setMessage("Failed to clear credentials. Please try again.");
      setMessageType("error");
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddPrize = async () => {
    if (!newPrizeName.trim()) {
      setPrizeMessage("Please enter a prize name.");
      setPrizeMessageType("error");
      return;
    }
    if (!newPrizePercentage || isNaN(Number(newPrizePercentage))) {
      setPrizeMessage("Please enter a valid percentage.");
      setPrizeMessageType("error");
      return;
    }
    if (!newPokemonImage && newSportsImages.length === 0) {
      setPrizeMessage("Please select at least one image (Pokemon or Sports).");
      setPrizeMessageType("error");
      return;
    }
    const percentage = Number(newPrizePercentage);
    if (percentage < 0 || percentage > 100) {
      setPrizeMessage("Percentage must be between 0 and 100.");
      setPrizeMessageType("error");
      return;
    }

    // Check if percentages will sum to 100
    if (prizes) {
      const currentTotal = prizes.reduce(
        (sum, prize) => sum + prize.percentage,
        0,
      );
      const newTotal = currentTotal + percentage;
      if (newTotal !== 100) {
        const diff = 100 - newTotal;
        setPrizeMessage(
          `Prize percentages must sum to 100%. Current total with this prize would be ${newTotal}% (${diff > 0 ? "+" + diff : diff}%).`,
        );
        setPrizeMessageType("error");
        return;
      }
    } else {
      if (percentage !== 100) {
        setPrizeMessage(
          `Prize percentage must be exactly 100% (currently ${percentage}%).`,
        );
        setPrizeMessageType("error");
        return;
      }
    }

    setIsLoading(true);
    setPrizeMessage("");
    try {
      let pokemonImageUrl: string | undefined;
      const sportsImageUrls: string[] = [];

      // Upload Pokemon image if provided
      if (newPokemonImage) {
        const uploadResult = await uploadPrizeImage({
          imageBase64: newPokemonImage,
          prizeName: `${newPrizeName.trim()}_pokemon`,
        });

        if (!uploadResult.success || !uploadResult.imageUrl) {
          throw new Error(uploadResult.message);
        }
        pokemonImageUrl = uploadResult.imageUrl;
      }

      // Upload Sports images if provided
      for (let i = 0; i < newSportsImages.length; i++) {
        const uploadResult = await uploadPrizeImage({
          imageBase64: newSportsImages[i],
          prizeName: `${newPrizeName.trim()}_sports_${i + 1}`,
        });

        if (!uploadResult.success || !uploadResult.imageUrl) {
          throw new Error(uploadResult.message);
        }
        sportsImageUrls.push(uploadResult.imageUrl);
      }

      // Create prize with both image URLs
      await createPrize({
        prizeName: newPrizeName.trim(),
        percentage,
        pokemonImageUrl,
        sportsImageUrls:
          sportsImageUrls.length > 0 ? sportsImageUrls : undefined,
      });
      setNewPrizeName("");
      setNewPrizePercentage("");
      setNewPokemonImage(null);
      setNewPokemonImagePreview(null);
      setNewSportsImages([]);
      setNewSportsImagePreviews([]);
      setPrizeMessage("Prize added successfully!");
      setPrizeMessageType("success");
    } catch (error) {
      setPrizeMessage(
        `Failed to add prize: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
      setPrizeMessageType("error");
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpdatePrize = async () => {
    if (!editingPrizeId) return;
    if (!editPrizeName.trim()) {
      setPrizeMessage("Please enter a prize name.");
      setPrizeMessageType("error");
      return;
    }
    if (!editPrizePercentage || isNaN(Number(editPrizePercentage))) {
      setPrizeMessage("Please enter a valid percentage.");
      setPrizeMessageType("error");
      return;
    }
    const percentage = Number(editPrizePercentage);
    if (percentage < 0 || percentage > 100) {
      setPrizeMessage("Percentage must be between 0 and 100.");
      setPrizeMessageType("error");
      return;
    }

    // Check if percentages will sum to 100
    if (prizes) {
      const currentTotal = prizes.reduce(
        (sum, prize) => sum + prize.percentage,
        0,
      );
      const editingPrize = prizes.find((p) => p._id === editingPrizeId);
      const editingPrizePercentage = editingPrize?.percentage || 0;
      const newTotal = currentTotal - editingPrizePercentage + percentage;
      if (newTotal !== 100) {
        const diff = 100 - newTotal;
        setPrizeMessage(
          `Prize percentages must sum to 100%. Current total with this change would be ${newTotal}% (${diff > 0 ? "+" + diff : diff}%).`,
        );
        setPrizeMessageType("error");
        return;
      }
    }

    setIsLoading(true);
    setPrizeMessage("");
    try {
      let pokemonImageUrl: string | undefined;
      const sportsImageUrls: string[] = [];

      // Upload new Pokemon image if selected
      if (
        editPokemonImage &&
        editPokemonImage !== editPokemonImagePreview?.split(",")[1]
      ) {
        const uploadResult = await uploadPrizeImage({
          imageBase64: editPokemonImage,
          prizeName: `${editPrizeName.trim()}_pokemon`,
        });

        if (!uploadResult.success || !uploadResult.imageUrl) {
          throw new Error(uploadResult.message);
        }
        pokemonImageUrl = uploadResult.imageUrl;
      }

      // Upload new Sports images if selected
      for (let i = 0; i < editSportsImages.length; i++) {
        const currentImage = editSportsImages[i];
        const isNewImage = !editSportsImagePreviews.some(
          (preview) =>
            preview === currentImage || currentImage === preview.split(",")[1],
        );

        if (isNewImage) {
          const uploadResult = await uploadPrizeImage({
            imageBase64: currentImage,
            prizeName: `${editPrizeName.trim()}_sports_${i + 1}`,
          });

          if (!uploadResult.success || !uploadResult.imageUrl) {
            throw new Error(uploadResult.message);
          }
          sportsImageUrls.push(uploadResult.imageUrl);
        } else {
          sportsImageUrls.push(currentImage);
        }
      }

      // Update prize
      await updatePrize({
        prizeId: editingPrizeId,
        prizeName: editPrizeName.trim(),
        percentage,
        pokemonImageUrl,
        sportsImageUrls:
          sportsImageUrls.length > 0 ? sportsImageUrls : undefined,
      });
      setEditingPrizeId(null);
      setEditPrizeName("");
      setEditPrizePercentage("");
      setEditPokemonImage(null);
      setEditPokemonImagePreview(null);
      setEditSportsImages([]);
      setEditSportsImagePreviews([]);
      setPrizeMessage("Prize updated successfully!");
      setPrizeMessageType("success");
    } catch (error) {
      setPrizeMessage(
        `Failed to update prize: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
      setPrizeMessageType("error");
    } finally {
      setIsLoading(false);
    }
  };

  const handleEditPrize = (
    prizeId: Id<"prizePool">,
    prizeName: string,
    percentage: number,
    pokemonImageUrl?: string,
    sportsImageUrls?: string[],
  ) => {
    setEditingPrizeId(prizeId);
    setEditPrizeName(prizeName);
    setEditPrizePercentage(percentage.toString());
    setEditPokemonImage(null);
    setEditPokemonImagePreview(pokemonImageUrl || null);
    setEditSportsImages([]);
    setEditSportsImagePreviews(sportsImageUrls || []);
    setPrizeMessage("");
  };

  const handleDeletePrize = async (prizeId: Id<"prizePool">) => {
    if (!confirm("Are you sure you want to delete this prize?")) {
      return;
    }

    setIsLoading(true);
    setPrizeMessage("");
    try {
      await deletePrize({ prizeId });
      setPrizeMessage("Prize deleted successfully!");
      setPrizeMessageType("success");
    } catch (error) {
      setPrizeMessage(
        `Failed to delete prize: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
      setPrizeMessageType("error");
    } finally {
      setIsLoading(false);
    }
  };

  const cancelEditPrize = () => {
    setEditingPrizeId(null);
    setEditPrizeName("");
    setEditPrizePercentage("");
    setEditPokemonImage(null);
    setEditPokemonImagePreview(null);
    setEditSportsImages([]);
    setEditSportsImagePreviews([]);
    setPrizeMessage("");
  };

  const handleImageFileChange = (
    e: React.ChangeEvent<HTMLInputElement>,
    imageType: "pokemon" | "sports",
    isEdit: boolean = false,
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith("image/")) {
      setPrizeMessage("Please select a valid image file.");
      setPrizeMessageType("error");
      return;
    }

    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      setPrizeMessage("Image size must be less than 5MB.");
      setPrizeMessageType("error");
      return;
    }

    // Convert to base64
    const reader = new FileReader();
    reader.onload = (event) => {
      const base64String = event.target?.result as string;
      if (isEdit) {
        if (imageType === "pokemon") {
          setEditPokemonImage(base64String);
          setEditPokemonImagePreview(base64String);
        } else {
          setEditSportsImages([...editSportsImages, base64String]);
          setEditSportsImagePreviews([
            ...editSportsImagePreviews,
            base64String,
          ]);
        }
      } else {
        if (imageType === "pokemon") {
          setNewPokemonImage(base64String);
          setNewPokemonImagePreview(base64String);
        } else {
          setNewSportsImages([...newSportsImages, base64String]);
          setNewSportsImagePreviews([...newSportsImagePreviews, base64String]);
        }
      }
      setPrizeMessage("");
    };
    reader.readAsDataURL(file);
  };

  const removeSportsImage = (index: number, isEdit: boolean = false) => {
    if (isEdit) {
      setEditSportsImages(editSportsImages.filter((_, i) => i !== index));
      setEditSportsImagePreviews(
        editSportsImagePreviews.filter((_, i) => i !== index),
      );
    } else {
      setNewSportsImages(newSportsImages.filter((_, i) => i !== index));
      setNewSportsImagePreviews(
        newSportsImagePreviews.filter((_, i) => i !== index),
      );
    }
  };

  const handleDrag = (
    e: React.DragEvent<HTMLDivElement>,
    isActive: boolean,
    imageType: "pokemon" | "sports",
  ) => {
    e.preventDefault();
    e.stopPropagation();
    if (imageType === "pokemon") {
      setPokemonDragActive(isActive);
    } else {
      setSportsDragActive(isActive);
    }
  };

  const handleDropFile = (
    e: React.DragEvent<HTMLDivElement>,
    imageType: "pokemon" | "sports",
    isEdit: boolean = false,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    if (imageType === "pokemon") {
      setPokemonDragActive(false);
    } else {
      setSportsDragActive(false);
    }

    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      const file = files[0];

      // Validate file type
      if (!file.type.startsWith("image/")) {
        setPrizeMessage("Please select a valid image file.");
        setPrizeMessageType("error");
        return;
      }

      // Validate file size (max 5MB)
      if (file.size > 5 * 1024 * 1024) {
        setPrizeMessage("Image size must be less than 5MB.");
        setPrizeMessageType("error");
        return;
      }

      // Convert to base64
      const reader = new FileReader();
      reader.onload = (event) => {
        const base64String = event.target?.result as string;
        if (isEdit) {
          if (imageType === "pokemon") {
            setEditPokemonImage(base64String);
            setEditPokemonImagePreview(base64String);
          } else {
            setEditSportsImages([...editSportsImages, base64String]);
            setEditSportsImagePreviews([
              ...editSportsImagePreviews,
              base64String,
            ]);
          }
        } else {
          if (imageType === "pokemon") {
            setNewPokemonImage(base64String);
            setNewPokemonImagePreview(base64String);
          } else {
            setNewSportsImages([...newSportsImages, base64String]);
            setNewSportsImagePreviews([
              ...newSportsImagePreviews,
              base64String,
            ]);
          }
        }
        setPrizeMessage("");
      };
      reader.readAsDataURL(file);
    }
  };

  return (
      <div className="space-y-8">
          <div>
            <h1 className="text-3xl font-bold mb-2">Profile Settings</h1>
            <p className="text-muted-foreground">
              Manage your account settings and credentials for supported
              platforms.
            </p>
          </div>
          {/* Public Profile Section */}
          <section className="space-y-6 p-6 border border-slate-800 rounded-lg">
            <div>
              <h2 className="text-xl font-semibold">Public Profile</h2>
              <p className="text-sm text-slate-400 mt-1">
                Your public collector page at neonbinder.com/u/[username]
              </p>
            </div>
            <PublicProfileEditor />
          </section>

          {/* Credentials Section */}
          <section className="space-y-6 p-6 border border-slate-200 dark:border-slate-800 rounded-lg">
            {profile === undefined ? (
              <p
                data-testid="credentials-loading"
                className="text-sm text-slate-400"
              >
                Loading credentials…
              </p>
            ) : (
              <>
              {/* Site Selector — tab-style buttons. Native <select> is not
                  drivable by Maestro web (it can focus the element but
                  cannot tap inside the native <option> popup, and
                  inputText doesn't simulate the keyboard event the
                  browser needs to type-to-select). Buttons are
                  click-driven, accessible (role="tab" each + role="tablist"),
                  and announce as a platform group to screen readers. */}
              <div>
                <span
                  id="site-select-label"
                  className="block text-sm font-medium mb-2"
                >
                  Select Platform
                </span>
                <div
                  role="tablist"
                  aria-labelledby="site-select-label"
                  className="flex flex-wrap gap-2"
                >
                  {SUPPORTED_SITES.map((site) => {
                    const isSelected = selectedSite === site.key;
                    return (
                      <button
                        key={site.key}
                        type="button"
                        role="tab"
                        aria-selected={isSelected}
                        aria-controls="site-credentials-panel"
                        onClick={() => { if (!credsBusy) setSelectedSite(site.key); }}
                        disabled={credsBusy}
                        className={
                          "px-4 py-2 rounded-md border text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-green-500 disabled:opacity-50 disabled:cursor-not-allowed " +
                          (isSelected
                            ? "border-green-500 bg-green-500/10 text-green-700 dark:text-green-300"
                            : "border-slate-300 dark:border-slate-600 hover:border-green-500 text-foreground")
                        }
                      >
                        {site.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            <div
              id="site-credentials-panel"
              role="tabpanel"
            >
              <h2 className="text-xl font-semibold mb-2">
                {siteMeta?.label} Credentials
              </h2>
              <p className="text-sm text-muted-foreground mb-4">
                Enter your {siteMeta?.label} login credentials to enable automatic authentication. Your credentials are securely encrypted and stored.
              </p>
            </div>

            {/* Credentials UI - same for all sites including BSC */}
            {/* If credentials are stored and not in edit mode, show summary and buttons */}
            {hasStoredCredentials && !editMode ? (
              <div className="space-y-4">
                <div className="p-4 bg-blue-50 dark:bg-blue-900/20 text-blue-800 dark:text-blue-200 border border-blue-200 dark:border-blue-800 rounded-md">
                  <strong>Credentials saved for {siteMeta?.label}</strong>
                  <p className="text-sm mt-1">
                    Your credentials are securely stored. You can edit or test
                    them below.
                  </p>
                </div>
                <div className="flex flex-col sm:flex-row gap-4">
                  <NeonButton
                    onClick={() => setEditMode(true)}
                    disabled={credsBusy}
                    className="flex-1"
                  >
                    Edit
                  </NeonButton>
                  <NeonButton
                    onClick={handleTestCredentials}
                    disabled={credsBusy}
                    className="flex-1 bg-slate-600 hover:bg-slate-700"
                  >
                    {isLoading ? "Testing..." : "Test Credentials"}
                  </NeonButton>
                  <NeonButton
                    onClick={handleClearCredentials}
                    disabled={credsBusy}
                    className="flex-1 bg-red-600 hover:bg-red-700"
                  >
                    {isLoading ? "Clearing..." : "Clear Credentials"}
                  </NeonButton>
                </div>
              </div>
            ) : (
              // Show input fields and Save/Test buttons if editing or no credentials
              <>
                <div className="space-y-4">
                  <div>
                    <label
                      htmlFor="username"
                      className="block text-sm font-medium mb-2"
                    >
                      {siteMeta?.label} Username/Email
                    </label>
                    <input
                      id="username"
                      type="text"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-green-500"
                      placeholder={`Enter your ${siteMeta?.label} username or email`}
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="password"
                      className="block text-sm font-medium mb-2"
                    >
                      {siteMeta?.label} Password
                    </label>
                    <input
                      id="password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-green-500"
                      placeholder={`Enter your ${siteMeta?.label} password`}
                    />
                  </div>
                  {selectedSite === "sportlots" && (
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      We recommend using a unique password for your SportLots account.
                    </p>
                  )}
                </div>
                <div className="flex flex-col sm:flex-row gap-4">
                  <NeonButton
                    onClick={handleSaveCredentials}
                    disabled={credsBusy || !username || !password}
                    className="flex-1"
                  >
                    {isLoading ? "Saving..." : "Save Credentials"}
                  </NeonButton>
                  <NeonButton
                    onClick={handleTestCredentials}
                    disabled={credsBusy || !hasStoredCredentials}
                    className="flex-1 bg-slate-600 hover:bg-slate-700"
                  >
                    {isLoading ? "Testing..." : "Test Stored Credentials"}
                  </NeonButton>
                  {hasStoredCredentials && (
                    <NeonButton
                      onClick={handleClearCredentials}
                      disabled={credsBusy}
                      className="flex-1 bg-red-600 hover:bg-red-700"
                    >
                      {isLoading ? "Clearing..." : "Clear Credentials"}
                    </NeonButton>
                  )}
                </div>
                {hasStoredCredentials && (
                  <NeonButton
                    onClick={() => setEditMode(false)}
                    disabled={credsBusy}
                    className="mt-2"
                  >
                    Cancel
                  </NeonButton>
                )}
              </>
            )}
            {confirmingClear && (
              // Centered modal overlay (not inline): a destructive confirm
              // belongs in a modal, and rendering it fixed/centered keeps it out
              // of the sticky-header occlusion band that was stealing the
              // "Yes, Clear" tap when the panel scrolled near the top (NEO-39).
              <div
                ref={clearDialogRef}
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
                role="dialog"
                aria-modal="true"
                aria-labelledby="clear-confirm-title"
                onClick={() => !credsBusy && setConfirmingClear(false)}
                onKeyDown={handleClearModalKeyDown}
              >
                <div
                  className="w-full max-w-md p-6 bg-white dark:bg-slate-800 border border-amber-200 dark:border-amber-800 rounded-lg shadow-xl"
                  onClick={(e) => e.stopPropagation()}
                >
                  <p
                    id="clear-confirm-title"
                    className="text-amber-800 dark:text-amber-200 font-medium mb-4"
                  >
                    Are you sure you want to clear your {siteMeta?.label} credentials?
                  </p>
                  <div className="flex gap-3">
                    <NeonButton
                      cancel
                      onClick={handleConfirmClear}
                      disabled={credsBusy}
                    >
                      {isLoading ? "Clearing..." : "Yes, Clear"}
                    </NeonButton>
                    <NeonButton
                      ref={clearCancelButtonRef}
                      onClick={() => setConfirmingClear(false)}
                      disabled={credsBusy}
                    >
                      Cancel
                    </NeonButton>
                  </div>
                </div>
              </div>
            )}
            {message && (
              <div
                className={`p-4 rounded-md ${
                  messageType === "success"
                    ? "bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-200 border border-green-200 dark:border-green-800"
                    : "bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-200 border border-red-200 dark:border-red-800"
                }`}
              >
                <div className="font-medium">{message}</div>
                {messageDetails && (
                  <div className="mt-2 text-sm opacity-90">
                    <hr
                      className={`my-2 border-t ${
                        messageType === "success"
                          ? "border-green-200 dark:border-green-700"
                          : "border-red-200 dark:border-red-700"
                      }`}
                    />
                    {messageDetails}
                  </div>
                )}
              </div>
            )}
            {hasStoredCredentials && !isAuthenticated && (
              <div className="p-4 bg-blue-50 dark:bg-blue-900/20 text-blue-800 dark:text-blue-200 border border-blue-200 dark:border-blue-800 rounded-md">
                <strong>Credentials Stored</strong>
                <p className="text-sm mt-1">
                  Your credentials are saved. Click &quot;Test Stored
                  Credentials&quot; to verify they work.
                </p>
              </div>
            )}

              {/* Security Information */}
              <div className="p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
                <h3 className="font-semibold text-blue-900 dark:text-blue-100 mb-2">
                  Security Information
                </h3>
                <ul className="text-sm text-blue-800 dark:text-blue-200 space-y-1">
                  <li>
                    • Your credentials are securely encrypted and stored
                  </li>
                  <li>
                    • Credentials are only accessible to your account
                  </li>
                  <li>• We never share your credentials with third parties</li>
                  <li>• You can clear your credentials at any time</li>
                </ul>
              </div>
              </>
            )}
          </section>

          {/* Prize Pool Section - Feature Flagged */}
          {isPrizeImagesEnabled ? (
            <div className="space-y-6 p-6 border border-slate-200 dark:border-slate-800 rounded-lg">
              <div>
                <h2 className="text-xl font-semibold mb-2">Prize Pool</h2>
                <p className="text-sm text-muted-foreground mb-4">
                  Manage your prize pool for the wheel of fortune spin. Prizes
                  with higher percentages are more likely to be won.
                </p>
              </div>

            {/* Add/Edit Prize Form */}
            <div className="space-y-4 p-4 bg-slate-50 dark:bg-slate-900/30 rounded-md">
              <div>
                <label
                  htmlFor={editingPrizeId ? "edit-prize-name" : "prize-name"}
                  className="block text-sm font-medium mb-2"
                >
                  Prize Name
                </label>
                <input
                  id={editingPrizeId ? "edit-prize-name" : "prize-name"}
                  type="text"
                  value={editingPrizeId ? editPrizeName : newPrizeName}
                  onChange={(e) =>
                    editingPrizeId
                      ? setEditPrizeName(e.target.value)
                      : setNewPrizeName(e.target.value)
                  }
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-green-500"
                  placeholder="Enter prize name (e.g., Extra Card, Booster Pack)"
                />
              </div>
              <div>
                <label
                  htmlFor={
                    editingPrizeId
                      ? "edit-prize-percentage"
                      : "prize-percentage"
                  }
                  className="block text-sm font-medium mb-2"
                >
                  Win Percentage (0-100)
                </label>
                <input
                  id={
                    editingPrizeId
                      ? "edit-prize-percentage"
                      : "prize-percentage"
                  }
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  value={
                    editingPrizeId ? editPrizePercentage : newPrizePercentage
                  }
                  onChange={(e) =>
                    editingPrizeId
                      ? setEditPrizePercentage(e.target.value)
                      : setNewPrizePercentage(e.target.value)
                  }
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-md bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-green-500"
                  placeholder="Enter percentage (0-100)"
                />
              </div>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-2">
                    Pokémon Image{" "}
                    {editingPrizeId && "(leave blank to keep current)"}
                  </label>
                  <div
                    onDragEnter={(e) => handleDrag(e, true, "pokemon")}
                    onDragLeave={(e) => handleDrag(e, false, "pokemon")}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) =>
                      handleDropFile(e, "pokemon", editingPrizeId !== null)
                    }
                    className={`w-full p-6 border-2 border-dashed rounded-md transition-colors ${
                      pokemonDragActive
                        ? "border-green-500 bg-green-50 dark:bg-green-900/20"
                        : "border-slate-300 dark:border-slate-600 bg-background hover:border-green-400"
                    }`}
                  >
                    <input
                      id={
                        editingPrizeId
                          ? "edit-prize-pokemon-image"
                          : "prize-pokemon-image"
                      }
                      type="file"
                      accept="image/*"
                      onChange={(e) =>
                        handleImageFileChange(
                          e,
                          "pokemon",
                          editingPrizeId !== null,
                        )
                      }
                      className="hidden"
                    />
                    <label
                      htmlFor={
                        editingPrizeId
                          ? "edit-prize-pokemon-image"
                          : "prize-pokemon-image"
                      }
                      className="cursor-pointer flex flex-col items-center justify-center gap-2"
                    >
                      <div className="text-2xl">📸</div>
                      <div className="text-sm text-foreground font-medium">
                        Drag and drop your image here
                      </div>
                      <div className="text-xs text-muted-foreground">
                        or click to select
                      </div>
                    </label>
                  </div>
                </div>
                {(editingPrizeId
                  ? editPokemonImagePreview
                  : newPokemonImagePreview) && (
                  <div className="mt-2">
                    <p className="text-sm font-medium mb-2">Pokémon Preview:</p>
                    <img
                      src={
                        (editingPrizeId
                          ? editPokemonImagePreview
                          : newPokemonImagePreview) ?? undefined
                      }
                      alt="Pokemon preview"
                      className="h-32 w-32 object-cover rounded-md border border-slate-300 dark:border-slate-600"
                    />
                  </div>
                )}
              </div>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-2">
                    Sports Images{" "}
                    {editingPrizeId && "(leave blank to keep current)"}
                  </label>
                  <div
                    onDragEnter={(e) => handleDrag(e, true, "sports")}
                    onDragLeave={(e) => handleDrag(e, false, "sports")}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) =>
                      handleDropFile(e, "sports", editingPrizeId !== null)
                    }
                    className={`w-full p-6 border-2 border-dashed rounded-md transition-colors ${
                      sportsDragActive
                        ? "border-green-500 bg-green-50 dark:bg-green-900/20"
                        : "border-slate-300 dark:border-slate-600 bg-background hover:border-green-400"
                    }`}
                  >
                    <input
                      id={
                        editingPrizeId
                          ? "edit-prize-sports-image"
                          : "prize-sports-image"
                      }
                      type="file"
                      accept="image/*"
                      onChange={(e) =>
                        handleImageFileChange(
                          e,
                          "sports",
                          editingPrizeId !== null,
                        )
                      }
                      className="hidden"
                    />
                    <label
                      htmlFor={
                        editingPrizeId
                          ? "edit-prize-sports-image"
                          : "prize-sports-image"
                      }
                      className="cursor-pointer flex flex-col items-center justify-center gap-2"
                    >
                      <div className="text-2xl">⚽</div>
                      <div className="text-sm text-foreground font-medium">
                        Drag and drop your image here
                      </div>
                      <div className="text-xs text-muted-foreground">
                        or click to select (upload multiple)
                      </div>
                    </label>
                  </div>
                </div>
                {(editingPrizeId
                  ? editSportsImagePreviews
                  : newSportsImagePreviews
                ).length > 0 && (
                  <div className="mt-2">
                    <p className="text-sm font-medium mb-2">
                      Sports Previews (
                      {
                        (editingPrizeId
                          ? editSportsImagePreviews
                          : newSportsImagePreviews
                        ).length
                      }
                      ):
                    </p>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      {(editingPrizeId
                        ? editSportsImagePreviews
                        : newSportsImagePreviews
                      ).map((preview, index) => (
                        <div key={index} className="relative">
                          <img
                            src={preview}
                            alt={`Sports preview ${index + 1}`}
                            className="h-24 w-24 object-cover rounded-md border border-slate-300 dark:border-slate-600"
                          />
                          <button
                            type="button"
                            onClick={() =>
                              removeSportsImage(index, editingPrizeId !== null)
                            }
                            className="absolute -top-2 -right-2 bg-red-500 hover:bg-red-600 text-white rounded-full w-6 h-6 flex items-center justify-center text-sm"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              {editingPrizeId ? (
                <div className="flex gap-2">
                  <NeonButton
                    onClick={handleUpdatePrize}
                    disabled={isLoading}
                    className="flex-1"
                  >
                    {isLoading ? "Processing..." : "Update Prize"}
                  </NeonButton>
                  <NeonButton
                    onClick={cancelEditPrize}
                    disabled={isLoading}
                    className="flex-1 bg-slate-600 hover:bg-slate-700"
                  >
                    Cancel
                  </NeonButton>
                </div>
              ) : (
                <div className="w-full">
                  <NeonButton
                    onClick={handleAddPrize}
                    disabled={isLoading}
                    className="w-full"
                    style={{ width: "100%" }}
                  >
                    {isLoading ? "Processing..." : "Add Prize"}
                  </NeonButton>
                </div>
              )}
            </div>

            {/* Prize Messages */}
            {isMounted && prizeMessage && (
              <div
                className={`p-4 rounded-md ${
                  prizeMessageType === "success"
                    ? "bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-200 border border-green-200 dark:border-green-800"
                    : "bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-200 border border-red-200 dark:border-red-800"
                }`}
              >
                <div className="font-medium">{prizeMessage}</div>
              </div>
            )}

            {/* Prizes List */}
            {isMounted &&
              (prizes && prizes.length > 0 ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-sm">
                      Your Prizes ({prizes.length})
                    </h3>
                    <div
                      className={`text-sm font-medium ${
                        prizes.reduce(
                          (sum, prize) => sum + prize.percentage,
                          0,
                        ) === 100
                          ? "text-green-600 dark:text-green-400"
                          : "text-red-600 dark:text-red-400"
                      }`}
                    >
                      Total:{" "}
                      {prizes.reduce((sum, prize) => sum + prize.percentage, 0)}
                      %
                    </div>
                  </div>
                  <div className="space-y-3">
                    {prizes.map((prize) => (
                      <div
                        key={prize._id}
                        className="flex items-start justify-between p-4 bg-slate-50 dark:bg-slate-900/30 rounded-md border border-slate-200 dark:border-slate-700"
                      >
                        <div className="flex items-start gap-4 flex-1 min-w-0">
                          <div className="flex flex-wrap gap-3 flex-shrink-0">
                            {prize.pokemonImageUrl && (
                              <div className="flex flex-col items-center">
                                <img
                                  src={prize.pokemonImageUrl}
                                  alt={`${prize.prizeName} Pokemon`}
                                  className="h-20 w-20 object-cover rounded border border-slate-300 dark:border-slate-600"
                                />
                                <span className="text-xs mt-1 text-muted-foreground">
                                  Pokémon
                                </span>
                              </div>
                            )}
                            {prize.sportsImageUrls &&
                              prize.sportsImageUrls.length > 0 && (
                                <>
                                  {prize.sportsImageUrls.map(
                                    (imageUrl, index) => (
                                      <div
                                        key={index}
                                        className="flex flex-col items-center"
                                      >
                                        <img
                                          src={imageUrl}
                                          alt={`${prize.prizeName} Sports ${index + 1}`}
                                          className="h-20 w-20 object-cover rounded border border-slate-300 dark:border-slate-600"
                                        />
                                        <span className="text-xs mt-1 text-muted-foreground">
                                          Sports
                                        </span>
                                      </div>
                                    ),
                                  )}
                                </>
                              )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="font-medium truncate">
                              {prize.prizeName}
                            </p>
                            <p className="text-sm text-muted-foreground">
                              {prize.percentage}% win chance
                            </p>
                          </div>
                        </div>
                        <div className="flex gap-2 ml-4 flex-shrink-0">
                          <NeonButton
                            onClick={() =>
                              handleEditPrize(
                                prize._id,
                                prize.prizeName,
                                prize.percentage,
                                prize.pokemonImageUrl,
                                prize.sportsImageUrls,
                              )
                            }
                            disabled={isLoading || editingPrizeId !== null}
                            className="bg-slate-600 hover:bg-slate-700 px-3 py-1 text-sm"
                          >
                            Edit
                          </NeonButton>
                          <NeonButton
                            onClick={() => handleDeletePrize(prize._id)}
                            disabled={isLoading}
                            className="bg-red-600 hover:bg-red-700 px-3 py-1 text-sm"
                          >
                            Delete
                          </NeonButton>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="p-4 bg-slate-50 dark:bg-slate-900/30 rounded-md text-center text-muted-foreground">
                  <p>No prizes configured yet. Add your first prize above.</p>
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-6 p-6 border border-slate-200 dark:border-slate-800 rounded-lg">
              <div>
                <h2 className="text-xl font-semibold mb-2">Prize Pool</h2>
                <p className="text-sm text-muted-foreground mb-4">
                  Manage your prize pool for the wheel of fortune spin.
                </p>
              </div>
              <div className="p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-md">
                <p className="text-amber-800 dark:text-amber-200 font-medium">
                  🚀 Coming Soon!
                </p>
                <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
                  Prize pool management with image uploads is coming in a future update.
                </p>
              </div>
            </div>
          )}
        </div>
  );
}
