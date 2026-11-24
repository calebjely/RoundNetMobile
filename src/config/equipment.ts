export interface NetSpec {
  rimDiameter: number;   // 0.914 m (36 in)
  rimRadius: number;     // 0.457 m
  rimTubeRadius: number; // 0.022 m
  netHeight: number;     // 0.203 m (8 in)
  legCount: number;      // 5 radial legs
  netRestitution: number;
  netHorizontalDamping: number;
  rimRestitution: number;
  rimChaosFactor: number;
}

export interface BallSpec {
  diameter: number;      // 0.105 m
  radius: number;        // 0.0525 m (330 mm circumference)
  massKg: number;        // 0.085 kg (85 g)
  colorHex: number;
  customTextureUrl?: string;
  /** Slightly softened gravity for mobile hang-time playability (real = 9.81) */
  gravity: number;
  /** Aerodynamic quadratic drag coefficient */
  airDrag: number;
  /** Linear damping for gentle hang-time deceleration */
  linearDamping: number;
  groundRestitution: number;
}

export const OFFICIAL_NET: NetSpec = {
  rimDiameter: 0.914,
  rimRadius: 0.457,
  rimTubeRadius: 0.022,
  netHeight: 0.203,
  legCount: 5,
  netRestitution: 0.92,
  netHorizontalDamping: 0.72,
  rimRestitution: 0.76,
  rimChaosFactor: 0.35,
};

export const OFFICIAL_BALL: BallSpec = {
  diameter: 0.105,
  radius: 0.0525,
  massKg: 0.085,
  colorHex: 0xfacc15,
  customTextureUrl: undefined,
  gravity: -9.81,
  airDrag: 0.022,
  linearDamping: 0.08,
  groundRestitution: 0.52,
};
