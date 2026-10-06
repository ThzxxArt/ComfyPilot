# ComfyPilot Icons

Neon “C + workflow node graph + arrow” brand mark.

| File | Size | Use |
|------|------|-----|
| `ComfyPilot.ico` | multi-size | Windows app / installer / taskbar |
| `ComfyPilot.icns` | multi-size | macOS app bundle |
| `comfypilot-windows-48.png` | 48 | small Windows asset |
| `comfypilot-windows-256.png` | 256 | Windows runtime window icon (fallback) |
| `comfypilot-windows-1024.png` | 1024 | Windows source |
| `comfypilot-macos-512.png` | 512 | macOS source / fallback |
| `comfypilot-macos-1024.png` | 1024 | macOS source |
| `comfypilot-appstore-64.png` | 64 | store / docs |
| `comfypilot-appstore-120.png` | 120 | store |
| `comfypilot-appstore-180.png` | 180 | store |
| `comfypilot-appstore-512.png` | 512 | Linux / store |
| `comfypilot-appstore-1024.png` | 1024 | store / master |

Wired in:
- `electron-builder.yml` → `win.icon` / `nsis.*Icon` / `mac.icon` / `linux.icon`
- `src/main/index.ts` → `BrowserWindow.icon` (platform-aware resolution)
