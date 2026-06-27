"use node";

import { action } from "../_generated/server";
import { v } from "convex/values";
import { getCurrentUserId } from "../auth";
import { Storage } from "@google-cloud/storage";

// Initialize GCS client with credentials from base64 environment variable
export const getGCSClient = () => {
  const b64 = process.env.GOOGLE_APPLICATION_CREDENTIALS_B64;
  if (!b64) throw new Error("GOOGLE_APPLICATION_CREDENTIALS_B64 not set");
  const credentialsJson = Buffer.from(b64, "base64").toString("utf8");
  const credentials = JSON.parse(credentialsJson);
  return new Storage({ credentials });
};

/**
 * Upload a prize image to Google Cloud Storage
 */
export const uploadPrizeImage = action({
  args: {
    imageBase64: v.string(), // Base64 encoded image data (including data:image/... prefix)
    prizeName: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
    imageUrl: v.optional(v.string()),
    message: v.string(),
  }),
  handler: async (ctx, args) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) {
      return {
        success: false,
        message: "Not authenticated",
      };
    }

    // Check if GCP features are enabled
    if (process.env.GCP_FEATURES_ENABLED !== 'true') {
      return {
        success: false,
        message: "Prize image uploads are coming soon!",
      };
    }

    try {
      const gcs = getGCSClient();
      const bucket = gcs.bucket("neonbinder-prizes");

      // Parse the base64 data URL
      const dataUrlMatch = args.imageBase64.match(/^data:image\/(\w+);base64,(.+)$/);
      if (!dataUrlMatch) {
        return {
          success: false,
          message: "Invalid image format. Must be a data URL with base64 encoding.",
        };
      }

      const [, extension, base64Data] = dataUrlMatch;
      const imageBuffer = Buffer.from(base64Data, "base64");

      // Create a unique filename
      const timestamp = Date.now();
      const sanitizedPrizeName = args.prizeName
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "-")
        .replace(/-+/g, "-");
      const filename = `${userId}/${timestamp}-${sanitizedPrizeName}.${extension}`;

      // Upload to GCS
      const file = bucket.file(filename);
      await file.save(imageBuffer, {
        metadata: {
          contentType: `image/${extension}`,
          cacheControl: "public, max-age=31536000",
        },
      });

      // Make the file publicly readable
      await file.makePublic();

      // Construct the public URL
      const imageUrl = `https://storage.googleapis.com/neonbinder-prizes/${filename}`;

      return {
        success: true,
        imageUrl,
        message: "Prize image uploaded successfully",
      };
    } catch (error) {
      console.error("Failed to upload prize image to GCS:", error);
      return {
        success: false,
        message: error instanceof Error ? error.message : "Failed to upload image",
      };
    }
  },
});

/**
 * Upload a profile photo to Vercel Blob Storage
 * Overwrites any existing photo for this user (fixed filename).
 */
export const uploadProfilePhoto = action({
  args: {
    imageBase64: v.string(), // Base64 encoded image data (including data:image/... prefix)
  },
  returns: v.object({
    success: v.boolean(),
    imageUrl: v.optional(v.string()),
    message: v.string(),
  }),
  handler: async (ctx, args) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) {
      return {
        success: false,
        message: "Not authenticated",
      };
    }

    try {
      const { put } = await import("@vercel/blob");

      // Check if BLOB_READ_WRITE_TOKEN is available
      if (!process.env.BLOB_READ_WRITE_TOKEN) {
        return {
          success: false,
          message: "Vercel Blob storage not configured",
        };
      }

      // Parse the base64 data URL
      const dataUrlMatch = args.imageBase64.match(/^data:image\/(\w+);base64,(.+)$/);
      if (!dataUrlMatch) {
        return {
          success: false,
          message: "Invalid image format. Must be a data URL with base64 encoding.",
        };
      }

      const [, extension, base64Data] = dataUrlMatch;
      const imageBuffer = Buffer.from(base64Data, "base64");

      // Upload to Vercel Blob with userId in path
      const filename = `profile-photos/${userId}/profile-photo.${extension}`;

      const blob = await put(filename, imageBuffer, {
        contentType: `image/${extension}`,
        access: "public",
      });

      return {
        success: true,
        imageUrl: blob.url,
        message: "Profile photo uploaded successfully",
      };
    } catch (error) {
      console.error("Failed to upload profile photo to Vercel Blob:", error);
      return {
        success: false,
        message: error instanceof Error ? error.message : "Failed to upload photo",
      };
    }
  },
});

/**
 * Delete a prize image from Google Cloud Storage
 */
export const deletePrizeImage = action({
  args: {
    imageUrl: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
    message: v.string(),
  }),
  handler: async (ctx, args) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) {
      return {
        success: false,
        message: "Not authenticated",
      };
    }

    // Check if GCP features are enabled
    if (process.env.GCP_FEATURES_ENABLED !== 'true') {
      return {
        success: false,
        message: "Prize image deletion is coming soon!",
      };
    }

    try {
      // Extract filename from URL
      const urlMatch = args.imageUrl.match(/neonbinder-prizes\/(.+)$/);
      if (!urlMatch) {
        return {
          success: false,
          message: "Invalid image URL format",
        };
      }

      const filename = urlMatch[1];
      const gcs = getGCSClient();
      const bucket = gcs.bucket("neonbinder-prizes");
      const file = bucket.file(filename);

      await file.delete();

      return {
        success: true,
        message: "Prize image deleted successfully",
      };
    } catch (error) {
      console.error("Failed to delete prize image from GCS:", error);
      return {
        success: false,
        message: error instanceof Error ? error.message : "Failed to delete image",
      };
    }
  },
});
