import { action } from "./_generated/server";
import { v } from "convex/values";

export const resolveRedirect = action({
  args: { url: v.string() },
  returns: v.string(),
  handler: async (_ctx, args) => {
    let url = args.url;
    for (let i = 0; i < 10; i++) {
      const response = await fetch(url, { redirect: "manual" });
      const location = response.headers.get("location");
      if (!location) return url;
      url = new URL(location, url).href;
    }
    return url;
  },
});
