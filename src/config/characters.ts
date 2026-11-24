export type TeamId = 'A' | 'B';

export interface PlayerStats {
  /** 0.5 – 1.5 multiplier affecting max stamina pool & regen */
  stamina: number;
  /** 0.5 – 1.5 multiplier affecting walk & sprint velocity */
  speed: number;
  /** 0.5 – 1.5 multiplier affecting spike/drive launch speed */
  power: number;
  /** 0.5 – 1.5 multiplier affecting touch/drop/set accuracy */
  shortGame: number;
  /** 0.5 – 1.5 multiplier affecting deep serve/lob accuracy & reach */
  longGame: number;
}

export interface CharacterProfile {
  id: string;
  name: string;
  nickname: string;
  modelPath: string;
  stats: PlayerStats;
}

export const STARTER_MODEL_PATH = '/assets/characters/shannon.glb';

export const TEAM_COLORS: Record<TeamId, { primary: string; hex: number; ringHex: number; label: string }> = {
  A: {
    primary: '#3b82f6',
    hex: 0x3b82f6,
    ringHex: 0x60a5fa,
    label: 'Team Blue',
  },
  B: {
    primary: '#f97316',
    hex: 0xf97316,
    ringHex: 0xfb923c,
    label: 'Team Orange',
  },
};

export const USER_HIGHLIGHT_HEX = 0xfacc15;

export const MOVEMENT_TUNING = {
  baseWalkSpeed: 3.1,      // m/s
  baseFastWalkSpeed: 4.0,  // m/s (cap when exhausted)
  baseSprintSpeed: 6.4,    // m/s
  maxStamina: 100,
  staminaDrainPerSec: 26,
  staminaRegenPerSec: 18,
  staminaRecoverThreshold: 15,
  diveSpeedBoost: 7.5,     // m/s burst
  diveDuration: 0.42,      // s
  getUpDuration: 0.55,     // s
  blockReachRadius: 0.85,  // m
  hitReachRadius: 1.35,    // m
  diveReachBonus: 0.55,    // m extra reach during dive window
  playerRadius: 0.34,      // m
  playerHeight: 1.78,      // m
};

/**
 * Phase 1 7-Player Roster Registry.
 * Placeholder stat modifiers are centered around 1.00 for Phase 1 balance;
 * Phase 2 will plug in custom player ratings without code changes.
 */
export const ROSTER: CharacterProfile[] = [
  {
    id: 'jacob',
    name: 'Jacob',
    nickname: 'The Anchor',
    modelPath: STARTER_MODEL_PATH,
    stats: { stamina: 1.05, speed: 1.0, power: 1.02, shortGame: 1.04, longGame: 1.0 },
  },
  {
    id: 'caleb',
    name: 'Caleb',
    nickname: 'Quickdraw',
    modelPath: STARTER_MODEL_PATH,
    stats: { stamina: 1.04, speed: 1.06, power: 1.0, shortGame: 1.03, longGame: 1.02 },
  },
  {
    id: 'rob',
    name: 'Rob',
    nickname: 'Cannon',
    modelPath: STARTER_MODEL_PATH,
    stats: { stamina: 0.98, speed: 0.98, power: 1.1, shortGame: 0.96, longGame: 1.06 },
  },
  {
    id: 'zach',
    name: 'Zach',
    nickname: 'Velvet Touch',
    modelPath: STARTER_MODEL_PATH,
    stats: { stamina: 1.0, speed: 1.02, power: 0.96, shortGame: 1.1, longGame: 1.0 },
  },
  {
    id: 'jerritt',
    name: 'Jerritt',
    nickname: 'Iron Lung',
    modelPath: STARTER_MODEL_PATH,
    stats: { stamina: 1.12, speed: 1.04, power: 1.0, shortGame: 1.0, longGame: 1.02 },
  },
  {
    id: 'kevin',
    name: 'Kevin',
    nickname: 'Skyhook',
    modelPath: STARTER_MODEL_PATH,
    stats: { stamina: 1.0, speed: 0.99, power: 1.05, shortGame: 1.0, longGame: 1.08 },
  },
  {
    id: 'dean',
    name: 'Dean',
    nickname: 'Sweeper',
    modelPath: STARTER_MODEL_PATH,
    stats: { stamina: 1.03, speed: 1.05, power: 0.98, shortGame: 1.05, longGame: 1.0 },
  },
];

export interface MatchParticipantConfig {
  slotIndex: number;
  profile: CharacterProfile;
  team: TeamId;
  isHuman: boolean;
  startPos: [number, number, number];
  /** Center angle (radians, atan2(x, z)) of the player's 90° pre-serve quarter slice */
  quarterCenterAngle: number;
}

export const PHASE1_LINEUP: MatchParticipantConfig[] = [
  {
    slotIndex: 0,
    profile: ROSTER[1], // Caleb (User) - South (+Z) quarter
    team: 'A',
    isHuman: true,
    startPos: [0, 0, 2.85],
    quarterCenterAngle: 0,
  },
  {
    slotIndex: 1,
    profile: ROSTER[0], // Jacob (Teammate) - West (-X) quarter
    team: 'A',
    isHuman: false,
    startPos: [-2.85, 0, 0],
    quarterCenterAngle: -Math.PI / 2,
  },
  {
    slotIndex: 2,
    profile: ROSTER[2], // Rob (Opponent 1) - North (-Z) quarter
    team: 'B',
    isHuman: false,
    startPos: [0, 0, -2.85],
    quarterCenterAngle: Math.PI,
  },
  {
    slotIndex: 3,
    profile: ROSTER[3], // Zach (Opponent 2) - East (+X) quarter
    team: 'B',
    isHuman: false,
    startPos: [2.85, 0, 0],
    quarterCenterAngle: Math.PI / 2,
  },
];
