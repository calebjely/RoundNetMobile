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
      position: [0, 0, 0],
      rotationY: 0,
      scale: 1,
    },
    // 3/4 elevated press-box angle centered on (0, 0, 0)
    cameraPosition: [0, 8.2, 10.6],
    cameraTarget: [0, 0.55, 0],
    fov: 46,
    maxZoomOutFactor: 1.45,
  },
};

export const DEFAULT_MAP_ID = 'the-eyebrow';
