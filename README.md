# RoundNetMobile

Mobile-first, web-based 3D Roundnet (Spikeball) court sandbox built with **Vite + TypeScript + React + Three.js + Spark 2.0 (`@sparkjsdev/spark`) + Rapier3D (`@dimforge/rapier3d-compat`)**.

Live deployment: **https://roundnetmobile.calebely.com**

---

## Asset Placement (`public/assets/`)

Cloudflare Workers Static Assets enforces a **25 MiB per-file limit**. Large `.spz` and `.glb` assets load asynchronously at runtime and fall back cleanly to procedural geometry if not present.

Drop your custom assets into the following paths:

| Asset | Path | Notes |
| --- | --- | --- |
| Gaussian Splat Court | `public/assets/maps/the-eyebrow/scene.spz` | Loaded via Spark 2.0 `SplatMesh` inside `courtGroup` |
| Court Collision Mesh | `public/assets/maps/the-eyebrow/scene.collision.glb` | Prefix obstacle meshes with `obstacle_` for Redo interference detection |
| Starter Character Rig | `public/assets/characters/shannon.glb` | Mixamo-rigged `.glb` cloned for all 4 players via `SkeletonUtils.clone()` |

If any of these files are missing (404), the engine automatically renders a procedural outdoor lawn court with perimeter obstacle trees/fences and articulated humanoid character rigs so the game is immediately playable.

---

## Scene Calibrator Mode

Append `?calibrate=1` to the URL, press **`F2`**, or open **Menu → Toggle Scene Calibrator** to unlock `OrbitControls`, adjust `courtGroup` (`position.x/y/z`, `rotation.y`, `scale`) and `fov`, and click **Copy View Config** to paste updated coordinates into `src/config/maps.ts`.

---

## Local Development & Deployment

```bash
npm install
npm run dev      # Local dev server
npm run build    # TypeScript check + production Vite bundle
npm run deploy   # Build + deploy to Cloudflare Workers (roundnetmobile.calebely.com)
```
