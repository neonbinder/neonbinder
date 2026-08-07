import { useState, useEffect } from "react";
import { useMutation, useAction, useQuery } from "convex/react";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import NeonButton from "@/components/modules/NeonButton";
import { Input } from "@/components/primitives/Input";

export default function PrizesPanel() {
  // Prize Pool state
  //
  // NEO-128: `isLoading` was one flag shared with the credentials section back
  // when both lived in a single component, so an in-flight prize upload also
  // disabled Save/Test/Clear Credentials (and vice versa) even though the two
  // operations are unrelated. Splitting the sections into routes gives each its
  // own flag, which is what the disabled states always meant to express.
  const [isLoading, setIsLoading] = useState(false);
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

  // Prize Pool mutations and queries
  const createPrize = useMutation(api.userProfile.createPrize);
  const updatePrize = useMutation(api.userProfile.updatePrize);
  const deletePrize = useMutation(api.userProfile.deletePrize);
  const uploadPrizeImage = useAction(api.adapters.gcs.uploadPrizeImage);
  const prizes = useQuery(api.userProfile.getPrizes);

  // Feature flags for GCP-dependent features
  const isPrizeImagesEnabled = useFeatureFlagEnabled("prize-images-enabled");

  // Set mounted flag after hydration
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot post-hydration flag; there is no render-time equivalent
    setIsMounted(true);
  }, []);

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
    <>
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
        <Input
          bare
          id={editingPrizeId ? "edit-prize-name" : "prize-name"}
          type="text"
          value={editingPrizeId ? editPrizeName : newPrizeName}
          onChange={(e) =>
            editingPrizeId
              ? setEditPrizeName(e.target.value)
              : setNewPrizeName(e.target.value)
          }
          className="w-full px-3 py-2"
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
        <Input
          bare
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
          className="w-full px-3 py-2"
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
    </>
  );
}
