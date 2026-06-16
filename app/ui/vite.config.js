import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The built UI is bundled into the macOS app and loaded from eos://app/ via a
// custom scheme handler, so asset URLs must resolve relative to index.html.
export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022",
    rollupOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: "highlight", test: /node_modules[\\/]highlight\.js[\\/]/ },
            { name: "markdown", test: /node_modules[\\/](marked|dompurify|diff)[\\/]/ },
          ],
        },
      },
    },
  },
  plugins: [react()],
});
