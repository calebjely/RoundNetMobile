export interface RulesConfig {
  /** Rally scoring target (15 default, configurable to 21) */
  pointsToWin: 15 | 21;
  winByTwo: boolean;
  /** IRF 2026 Equal Serving: first server 1 pt, then 2 pts per server, 1 in OT */
  equalServing: boolean;
  serveAttemptsPerPoint: number;
  /** 2.60 m service line radius */
  serviceLineRadius: number;
  /** 1.00 m (100 cm) No-Hit Zone radius */
  noHitZoneRadius: number;
  /** 8.50 m outer court boundary */
  outerBoundaryRadius: number;
  /** Max legal serve bounce height (receiver shoulder height ~1.45 m) */
  maxServeBounceHeight: number;
  /** Receiving team must use all 3 touches on first possession after serve */
  firstPossessionRequiresThreeTouches: boolean;
  /** Outside interference (obstacle_ / steep wall / tree) triggers Redo */
  outsideInterferenceRedo: boolean;
}

export const IRF_2026_RULES: RulesConfig = {
  pointsToWin: 15,
  winByTwo: true,
  equalServing: true,
  serveAttemptsPerPoint: 2,
  serviceLineRadius: 2.6,
  noHitZoneRadius: 1.0,
  outerBoundaryRadius: 8.5,
  maxServeBounceHeight: 1.45,
  firstPossessionRequiresThreeTouches: true,
  outsideInterferenceRedo: true,
};

export const RULES_QUICK_REFERENCE: string[] = [
  'Rally scoring to 15 (or 21), win by 2. Equal Serving: 1st server serves 1 point, then 2 points per server (1 in overtime).',
  'Server must stay behind the 2.60 m service line with 2 attempts. Serves bouncing above shoulder height, pocketed, or dying in the 1.00 m No-Hit Zone are faults.',
  'Receiving team MUST use all 3 touches on their first possession after a serve. Subsequent possessions allow 1–3 touches.',
  'No-Hit Zone (1.00 m): Final hitter cannot step on or inside the NHZ on strike or follow-through, and attacks cannot die inside the NHZ.',
  'Outside Interference (REDO): Live ball hitting any obstacle (tree, fence, bench, steep wall) stops play immediately with score unchanged and resets server to 1st serve.',
];
