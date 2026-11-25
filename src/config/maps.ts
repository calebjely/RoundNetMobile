export interface CourtOffsetConfig {
  position: [number, number, number];
  rotationY: number;
  scale: number;
}

export interface CameraPreset {
  position: [number, number, number];
  target: [number, number, number];
}

export type IntroCameraStyle = 'swoop90' | 'wide_zoom_tilt' | 'glide180' | 'low_flyover';

export type CameraViewMode = 'pressbox' | 'follow_behind' | 'first_person';

export interface CameraViewSettings {
  pressbox: CameraPreset;
  /** Press-Box zoom multiplier (0.50 = wide, 1.00 = default, 2.00 = zoomed in) */
  pressboxZoom: number;
  /** Follow-Behind distance behind player in meters (1.5 – 5.5) */
  followBehindDist: number;
  /** Follow-Behind camera height in meters (1.3 – 3.8) */
  followBehindHeight: number;
  /** First-Person eye height in meters (1.45 – 1.90) */
  fpEyeHeight: number;
  /** First-Person field of view in degrees (52 – 90) */
  fpFov: number;
}

export interface SavedCourtConfig {
  courtOffset: CourtOffsetConfig;
  /** Legacy 4 serving camera presets retained for backward compatibility */
  serveCameras: [CameraPreset, CameraPreset, CameraPreset, CameraPreset];
  /** Unified camera view settings applied to all players */
  cameraViewMode: CameraViewMode;
  cameraViewSettings: CameraViewSettings;
  /** Physics time scale multiplier (0.6 – 2.0, default 1.25) */
  physicsSpeed: number;
  /** Player movement speed multiplier (0.5 – 1.5, default 0.82) */
  playerSpeed: number;
  /** Start screen / match-reset camera intro movement */
  introCameraStyle: IntroCameraStyle;
}

export interface MapConfig {
  id: string;
  name: string;
  splatUrl: string;
  collisionUrl: string;
  courtOffset: CourtOffsetConfig;
  cameraPosition: [number, number, number];
  cameraTarget: [number, number, number];
  serveCameras: [CameraPreset, CameraPreset, CameraPreset, CameraPreset];
  fov: number;
  maxZoomOutFactor: number;
  defaultPhysicsSpeed: number;
  defaultPlayerSpeed: number;
}

function rotateXZ(
  [x, y, z]: [number, number, number],
  angleRad: number
): [number, number, number] {
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  return [
    Math.round((x * c + z * s) * 1000) / 1000,
    y,
    Math.round((-x * s + z * c) * 1000) / 1000,
  ];
}

const BASE_CAM_POS: [number, number, number] = [12.313, 8.064, -7.367];
const BASE_CAM_TGT: [number, number, number] = [0.138, 0.566, -0.112];

export const MAPS: Record<string, MapConfig> = {
  'the-eyebrow': {
    id: 'the-eyebrow',
    name: 'The Eyebrow',
    splatUrl: '/assets/maps/the-eyebrow/scene.spz',
    collisionUrl: '/assets/maps/the-eyebrow/scene.collision.glb',
    courtOffset: {
      position: [4.204, 0.38, -3.196],
      rotationY: 0.478,
      scale: 0.793,
    },
    cameraPosition: BASE_CAM_POS,
    cameraTarget: BASE_CAM_TGT,
    serveCameras: [
      { position: BASE_CAM_POS, target: BASE_CAM_TGT }, // Slot 0: South (+Z)
      { position: rotateXZ(BASE_CAM_POS, -Math.PI / 2), target: rotateXZ(BASE_CAM_TGT, -Math.PI / 2) }, // Slot 1: West (-X)
      { position: rotateXZ(BASE_CAM_POS, Math.PI), target: rotateXZ(BASE_CAM_TGT, Math.PI) }, // Slot 2: North (-Z)
      { position: rotateXZ(BASE_CAM_POS, Math.PI / 2), target: rotateXZ(BASE_CAM_TGT, Math.PI / 2) }, // Slot 3: East (+X)
    ],
    fov: 46,
    maxZoomOutFactor: 2.25,
    defaultPhysicsSpeed: 1.25,
    defaultPlayerSpeed: 0.74,
  },
};

export const DEFAULT_MAP_ID = 'the-eyebrow';

const STORAGE_KEY = 'roundnetmobile_court_config_v2';

export function getDefaultSavedConfig(map: MapConfig): SavedCourtConfig {
  return {
    courtOffset: {
      position: [...map.courtOffset.position],
      rotationY: map.courtOffset.rotationY,
      scale: map.courtOffset.scale,
    },
    serveCameras: map.serveCameras.map((c) => ({
      position: [...c.position] as [number, number, number],
      target: [...c.target] as [number, number, number],
    })) as [CameraPreset, CameraPreset, CameraPreset, CameraPreset],
    cameraViewMode: 'first_person',
    cameraViewSettings: {
      pressbox: {
        position: [...map.cameraPosition],
        target: [...map.cameraTarget],
      },
      pressboxZoom: 1.0,
      followBehindDist: 2.8,
      followBehindHeight: 2.15,
      fpEyeHeight: 1.66,
      fpFov: 62,
    },
    physicsSpeed: map.defaultPhysicsSpeed,
    playerSpeed: map.defaultPlayerSpeed,
    introCameraStyle: 'swoop90',
  };
}

export function loadLocalCourtConfig(map: MapConfig): SavedCourtConfig {
  const fallback = getDefaultSavedConfig(map);
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<SavedCourtConfig>;
    return mergeSavedConfig(fallback, parsed);
  } catch {
    return fallback;
  }
}

export async function fetchRemoteCourtConfig(map: MapConfig): Promise<SavedCourtConfig | null> {
  try {
    const res = await fetch('/api/config', { cache: 'no-store' });
    if (!res.ok) return null;
    const parsed = (await res.json()) as Partial<SavedCourtConfig> | null;
    if (!parsed) return null;
    const merged = mergeSavedConfig(getDefaultSavedConfig(map), parsed);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
    } catch {
      // ignore storage quota errors
    }
    return merged;
  } catch {
    return null;
  }
}

export async function persistCourtConfig(cfg: SavedCourtConfig): Promise<boolean> {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {
    // ignore storage errors
  }
  try {
    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cfg),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function mergeSavedConfig(
  fallback: SavedCourtConfig,
  parsed: Partial<SavedCourtConfig>
): SavedCourtConfig {
  const clamp = (v: unknown, min: number, max: number, dflt: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : dflt;

  const pView = parsed.cameraViewSettings;
  const legacyPressbox =
    Array.isArray(parsed.serveCameras) && parsed.serveCameras[0]?.position && parsed.serveCameras[0]?.target
      ? parsed.serveCameras[0]
      : undefined;

  return {
    courtOffset: parsed.courtOffset
      ? {
          position: parsed.courtOffset.position ?? fallback.courtOffset.position,
          rotationY: parsed.courtOffset.rotationY ?? fallback.courtOffset.rotationY,
          scale: parsed.courtOffset.scale ?? fallback.courtOffset.scale,
        }
      : fallback.courtOffset,
    serveCameras:
      Array.isArray(parsed.serveCameras) && parsed.serveCameras.length === 4
        ? (parsed.serveCameras.map((c, i) => ({
            position: c?.position ?? fallback.serveCameras[i].position,
            target: c?.target ?? fallback.serveCameras[i].target,
          })) as [CameraPreset, CameraPreset, CameraPreset, CameraPreset])
        : fallback.serveCameras,
    cameraViewMode:
      parsed.cameraViewMode === 'pressbox' ||
      parsed.cameraViewMode === 'follow_behind' ||
      parsed.cameraViewMode === 'first_person'
        ? parsed.cameraViewMode
        : fallback.cameraViewMode,
    cameraViewSettings: {
      pressbox: pView?.pressbox?.position && pView?.pressbox?.target
        ? {
            position: pView.pressbox.position,
            target: pView.pressbox.target,
          }
        : legacyPressbox ?? fallback.cameraViewSettings.pressbox,
      pressboxZoom: clamp(
        pView?.pressboxZoom,
        0.5,
        2.0,
        fallback.cameraViewSettings.pressboxZoom
      ),
      followBehindDist: clamp(
        pView?.followBehindDist,
        1.5,
        5.5,
        fallback.cameraViewSettings.followBehindDist
      ),
      followBehindHeight: clamp(
        pView?.followBehindHeight,
        1.3,
        3.8,
        fallback.cameraViewSettings.followBehindHeight
      ),
      fpEyeHeight: clamp(
        pView?.fpEyeHeight,
        1.45,
        1.9,
        fallback.cameraViewSettings.fpEyeHeight
      ),
      fpFov: clamp(pView?.fpFov, 52, 90, fallback.cameraViewSettings.fpFov),
    },
    physicsSpeed:
      typeof parsed.physicsSpeed === 'number' &&
      parsed.physicsSpeed >= 0.5 &&
      parsed.physicsSpeed <= 2.5
        ? parsed.physicsSpeed
        : fallback.physicsSpeed,
    playerSpeed:
      typeof parsed.playerSpeed === 'number' &&
      parsed.playerSpeed >= 0.4 &&
      parsed.playerSpeed <= 1.8
        ? parsed.playerSpeed
        : fallback.playerSpeed,
    introCameraStyle:
      parsed.introCameraStyle === 'swoop90' ||
      parsed.introCameraStyle === 'wide_zoom_tilt' ||
      parsed.introCameraStyle === 'glide180' ||
      parsed.introCameraStyle === 'low_flyover'
        ? parsed.introCameraStyle
        : fallback.introCameraStyle,
  };
}
