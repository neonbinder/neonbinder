import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Builds components/primitives/ as a standalone importable library
// (dist-design-system/) for the /design-sync Claude Design import.
// Does not affect the main `build` script (full SPA build).
export default defineConfig({
  plugins: [react()],
  publicDir: false,
  build: {
    outDir: "dist-design-system",
    emptyOutDir: true,
    lib: {
      entry: path.resolve(__dirname, "components/primitives/index.ts"),
      name: "NeonBinderPrimitives",
      formats: ["es"],
      fileName: () => "index.es.js",
    },
    rollupOptions: {
      external: ["react", "react-dom", "react/jsx-runtime", "react-router"],
    },
  },
});
