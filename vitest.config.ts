import { defineConfig } from "vitest/config"
import path from "path"

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    setupFiles: ["dotenv/config"],          // tests need DATABASE_URL
  },
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
})
