export interface CourtOffsetConfig {
  position: [number, number, number];
  rotationY: number;
  scale: number;
}

export interface MapConfig {
  id: string;
  name: string;
  splatUrl: string;
  collisionUrl: string;
  courtOffset: CourtOffsetConfig;
  cameraPosition: [number, number, number];
  cameraTarget: [number, number, number];
  fov: number;
  maxZoomOutFactor: number;
}

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
    // Calibrated 3/4 elevated press-box angle centered on (0, 0, 0)
    cameraPosition: [12.313, 8.064, -7.367],
    cameraTarget: [0.138, 0.566, -0.112],
    fov: 46,
    maxZoomOutFactor: 1.45,
  },
};

export const DEFAULT_MAP_ID = 'the-eyebrow';
