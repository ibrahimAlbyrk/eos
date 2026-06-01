import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Daemon serves the built UI at /web/*, so all asset URLs must be prefixed with /web/.
export default defineConfig({
  base: "/web/",
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
