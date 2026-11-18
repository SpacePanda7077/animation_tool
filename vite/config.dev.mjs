import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vitejs.dev/config/
export default defineConfig({
    base: "./",
    // keep Rust compiler errors visible in the terminal
    clearScreen: false,
    plugins: [react(), tailwindcss()],
    server: {
        port: 8080,
        // Tauri expects this exact port (devUrl in src-tauri/tauri.conf.json)
        strictPort: true,
        watch: {
            ignored: ["**/src-tauri/**"],
        },
    },
});
