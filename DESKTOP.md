# Skeletor desktop app (Tauri v2)

The editor runs in the browser (`npm run dev`) and as a desktop app. In the desktop app, Save, Open and Export JSON use native file dialogs instead of the browser's file APIs.

## One-time setup

1. Install Rust: https://rustup.rs
2. Install the platform prerequisites for Tauri v2: https://v2.tauri.app/start/prerequisites/
   - Windows: Microsoft C++ Build Tools (the WebView2 runtime is already on Windows 10/11)
   - macOS: Xcode Command Line Tools
   - Linux: webkit2gtk and a few system libraries (see the link)
3. Install the JS dependencies: `npm install`
4. Generate the app icons from the existing favicon (use a square PNG, 1024x1024 is best):
   `npm run tauri icon public/favicon.png`

## Run and build

```
npm run desktop:dev      # opens the app window with hot reload
npm run desktop:build    # installer / bundle in src-tauri/target/release/bundle
```

`desktop:dev` starts the Vite dev server on port 8080 itself (`beforeDevCommand`), so do not run `npm run dev` at the same time.

## How it is wired

| Piece | Where |
|---|---|
| Window size, app id, build commands | `src-tauri/tauri.conf.json` |
| Plugins (dialog, fs) | `src-tauri/src/lib.rs` |
| Allowed commands | `src-tauri/capabilities/default.json` |
| Browser or desktop switch, native dialogs | `src/platform/desktop.ts` |
| Save / Open project | `src/game/game-components/project.ts` |
| Export JSON | `downloadText` in `src/export/export-animation.ts` |

`isDesktop()` checks for the Tauri runtime, so the same code still works in a normal browser.
