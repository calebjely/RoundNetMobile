export interface CourtOffsetConfig {
  position: [number, number, number];
  rotationY: number;
  scale: number;
}

export interface CameraPreset {
  position: [number, number, number];
  target: [number, number, number];
}

export interface SavedCourtConfig {
  courtOffset: CourtOffsetConfig;
  /** 4 serving camera presets indexed by player slot (0=South, 1=West, 2=North, 3=East) */
  serveCameras: [CameraPreset, CameraPreset, CameraPreset, CameraPreset];
  /** Physics time scale multiplier (0.6 – 2.0, default 1.25) */
  physicsSpeed: number;
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
    physicsSpeed: map.defaultPhysicsSpeed,
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
    physicsSpeed:
      typeof parsed.physicsSpeed === 'number' &&
      parsed.physicsSpeed >= 0.5 &&
      parsed.physicsSpeed <= 2.5
        ? parsed.physicsSpeed
        : fallback.physicsSpeed,
  };
}
