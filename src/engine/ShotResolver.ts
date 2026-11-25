import * as THREE from 'three';
import { OFFICIAL_BALL, OFFICIAL_NET } from '../config/equipment';
import { CharacterController, AnimState } from './CharacterController';
import { SwipeEvent } from './InputManager';

export type TimingQuality = 'Early' | 'Perfect' | 'Late' | 'Bad';
export type TimingZone = 'green' | 'yellow' | 'red';

export interface ShotOutcome {
  velocity: THREE.Vector3;
  timing: TimingQuality;
  anim: AnimState;
  isAttackAtNet: boolean;
  triggeredDive: boolean;
}

/**
 * Computes ballistic velocity from P0 -> P1 in flightTime seconds under real gravity,
 * with small horizontal compensation for light air drag.
 */
export function computeBallisticVelocity(
  from: THREE.Vector3,
  to: THREE.Vector3,
  flightTime: number
): THREE.Vector3 {
  const t = Math.max(0.16, flightTime);
  const g = OFFICIAL_BALL.gravity; // -9.81
  const dragComp = 1 + (OFFICIAL_BALL.linearDamping * 0.5 + OFFICIAL_BALL.airDrag * 1.4) * t;
  const vx = ((to.x - from.x) / t) * dragComp;
  const vz = ((to.z - from.z) / t) * dragComp;
  const vy = (to.y - from.y - 0.5 * g * t * t) / t;
  return new THREE.Vector3(vx, vy, vz);
}

/**
 * Predicts where an airborne ball will cross targetY (while descending) or reach ground.
 */
export function predictBallIntercept(
  ballPos: THREE.Vector3,
  ballVel: THREE.Vector3,
  targetY = 1.05
): { x: number; z: number; time: number } {
  const g = OFFICIAL_BALL.gravity; // negative
  const y0 = ballPos.y;
  const vy = ballVel.y;

  // If ball is already below targetY and falling, predict ground impact instead
  const aimY = y0 < targetY && vy < 0 ? OFFICIAL_BALL.radius + 0.1 : targetY;

  const a = 0.5 * g;
  const b = vy;
  const c = y0 - aimY;
  const disc = b * b - 4 * a * c;

  let t = 0.2;
  if (disc >= 0) {
    // Descending root (-b - sqrt(disc)) / (2a) since a < 0
    const root = (-b - Math.sqrt(disc)) / (2 * a);
    if (root > 0.02 && root < 4.0) {
      t = root;
    } else {
      const groundC = y0 - OFFICIAL_BALL.radius;
      const gDisc = b * b - 4 * a * groundC;
      if (gDisc >= 0) {
        t = Math.max(0.05, (-b - Math.sqrt(gDisc)) / (2 * a));
      }
    }
  } else {
    // Apex is below aimY; predict ground impact
    const groundC = y0 - OFFICIAL_BALL.radius;
    const gDisc = b * b - 4 * a * groundC;
    if (gDisc >= 0) {
      t = Math.max(0.05, (-b - Math.sqrt(gDisc)) / (2 * a));
    }
  }

  const dragAtten = Math.exp(-OFFICIAL_BALL.linearDamping * t * 0.5);
  return {
    x: ballPos.x + ballVel.x * t * dragAtten,
    z: ballPos.z + ballVel.z * t * dragAtten,
    time: t,
  };
}

export const MAX_HITTING_HEIGHT = 1.98;

export class ShotResolver {
  public static evaluateTimingZone(
    barValue: number,
    screenCenterDist = 0
  ): { zone: TimingZone; quality: TimingQuality; spreadMult: number } {
    // Further from screen center = harder to hit cleanly
    const penalty = Math.min(0.2, screenCenterDist * 0.16);
    const distFromCenter = Math.abs(barValue - 0.5) + penalty;

    if (distFromCenter <= 0.12) {
      return { zone: 'green', quality: 'Perfect', spreadMult: 0.35 };
    }
    if (distFromCenter <= 0.28) {
      return {
        zone: 'yellow',
        quality: barValue < 0.5 ? 'Early' : 'Late',
        spreadMult: 1.0,
      };
    }
    return { zone: 'red', quality: 'Bad', spreadMult: 2.4 };
  }

  public static resolveRallyShot(
    player: CharacterController,
    teammate: CharacterController | undefined,
    ballPos: THREE.Vector3,
    _ballVel: THREE.Vector3,
    swipe: SwipeEvent,
    teamTouchesAfterThis: number,
    isFirstPossessionAfterServe: boolean,
    camRight = new THREE.Vector3(1, 0, 0),
    barValue = 0.5,
    screenCenterDist = 0
  ): ShotOutcome | null {
    const horizDist = Math.hypot(ballPos.x - player.position.x, ballPos.z - player.position.z);
    const baseReach = player.getEffectiveReach();
    // Auto-dive ONLY when ball is slightly out of normal reach and player swipes
    const shouldAutoDive =
      horizDist > baseReach * 0.92 &&
      horizDist <= baseReach + 0.78 &&
      ballPos.y <= MAX_HITTING_HEIGHT;

    const maxReach = baseReach + (shouldAutoDive ? 0.78 : 0);
    // Can hit on the way up OR down unless ball is above hitting height!
    if (horizDist > maxReach || ballPos.y > MAX_HITTING_HEIGHT) {
      return null;
    }

    const { zone, quality, spreadMult } = this.evaluateTimingZone(barValue, screenCenterDist);
    const timingSpread = 0.06 * spreadMult;
    const shortMod = player.config.profile.stats.shortGame;
    const powerMod = player.config.profile.stats.power;

    const swipeLen = Math.max(1, swipe.distancePx);
    const swipeDirX = swipe.dx / swipeLen;
    // Angle from straight UP (0 rad = straight up, ±PI/4 = 45° cone, ±PI/2 = side-to-side, ±PI = straight down)
    const angleFromUp = Math.atan2(swipe.dx, -swipe.dy);
    const absAngle = Math.abs(angleFromUp);

    // Faster swipe = harder hit!
    const powerRatio = THREE.MathUtils.clamp(swipe.speedPxPerSec / 1050, 0.35, 1.45) * powerMod;
    const distToNet = Math.hypot(player.position.x, player.position.z);
    const netPlaneY = OFFICIAL_NET.netHeight + OFFICIAL_BALL.radius;

    // Waiting longer = lower ballPos.y = tighter/flatter margin to clear net
    const lowHeightFactor = THREE.MathUtils.clamp((1.15 - ballPos.y) * 0.35, 0, 0.3);
    const lateralAim = camRight.clone().setY(0).normalize().multiplyScalar(swipeDirX * 0.28);

    const buildSetToTeammate = (flightTime: number, anim: AnimState): ShotOutcome => {
      const setTarget = teammate
        ? teammate.position.clone().lerp(new THREE.Vector3(0, 0, 0), 0.32)
        : new THREE.Vector3(-player.position.x * 0.25, 0, -player.position.z * 0.25);
      const r = Math.hypot(setTarget.x, setTarget.z);
      if (r < 1.35 && r > 0.01) {
        setTarget.x = (setTarget.x / r) * 1.45;
        setTarget.z = (setTarget.z / r) * 1.45;
      }
      setTarget.x += lateralAim.x * 1.4 + (Math.random() - 0.5) * timingSpread * 2;
      setTarget.z += lateralAim.z * 1.4 + (Math.random() - 0.5) * timingSpread * 2;
      setTarget.y = zone === 'red' ? 0.72 : 1.25;
      return {
        velocity: computeBallisticVelocity(ballPos, setTarget, flightTime),
        timing: quality,
        anim,
        isAttackAtNet: false,
        triggeredDive: shouldAutoDive,
      };
    };

    // 1. 90° UPWARD CONE (|angleFromUp| <= 45°): ALWAYS a Set to partner (unless Touch 3 -> high rainbow to net)
    if (absAngle <= Math.PI / 4) {
      if (teamTouchesAfterThis >= 3) {
        const missBias = (Math.random() - 0.5) * (timingSpread * 2.2 / shortMod);
        const target = new THREE.Vector3(
          lateralAim.x + missBias,
          netPlaneY + (zone === 'red' ? -0.05 : 0),
          lateralAim.z + missBias
        );
        const flightTime = THREE.MathUtils.clamp(
          (0.95 + distToNet * 0.12) / (0.85 + 0.15 * powerRatio),
          0.72,
          1.35
        );
        return {
          velocity: computeBallisticVelocity(ballPos, target, flightTime),
          timing: quality,
          anim: 'hit_high',
          isAttackAtNet: true,
          triggeredDive: shouldAutoDive,
        };
      }
      const setT = zone === 'red' ? 0.72 : quality === 'Early' ? 1.15 : 0.96;
      return buildSetToTeammate(setT, 'hit_high');
    }

    // 2. ANYWHERE ELSE (|angleFromUp| > 45°): ALWAYS a Hit matching the swipe angle!
    // On Touch 1 of serve receive, still allow a lob/pass toward net/partner if angled up-ish
    const badHitOffset =
      zone === 'red'
        ? (Math.random() - 0.5) * 0.85
        : (Math.random() - 0.5) * timingSpread * 1.8;
    const netDropOffset = zone === 'red' ? -0.06 : quality === 'Late' ? -0.025 : 0;

    if (absAngle <= (Math.PI * 5) / 12) {
      // 45°–75° diagonal: Lob toward the net (teammate can still scramble for it on Touch 1-2!)
      const target = new THREE.Vector3(
        lateralAim.x * 1.45 + badHitOffset,
        netPlaneY + netDropOffset + (zone === 'green' ? 0.02 : 0),
        lateralAim.z * 1.45 + badHitOffset
      );
      const flightTime = THREE.MathUtils.clamp(
        (0.68 + distToNet * 0.09) / (0.75 + 0.25 * powerRatio) - lowHeightFactor * 0.35,
        0.42,
        1.05
      );
      return {
        velocity: computeBallisticVelocity(ballPos, target, flightTime),
        timing: quality,
        anim: 'hit_high',
        isAttackAtNet: !isFirstPossessionAfterServe || teamTouchesAfterThis >= 3,
        triggeredDive: shouldAutoDive,
      };
    }

    if (absAngle <= (Math.PI * 3) / 4) {
      // 75°–135° side-to-side: Low Cut Shot toward the net
      const target = new THREE.Vector3(
        lateralAim.x * 1.65 + badHitOffset,
        netPlaneY + netDropOffset,
        lateralAim.z * 1.65 + badHitOffset
      );
      const baseT = THREE.MathUtils.clamp(
        (0.26 + distToNet * 0.05) / powerRatio - lowHeightFactor * 0.12,
        0.16,
        0.45
      );
      return {
        velocity: computeBallisticVelocity(ballPos, target, baseT),
        timing: quality,
        anim: 'hit_low',
        isAttackAtNet: true,
        triggeredDive: shouldAutoDive,
      };
    }

    // 135°–180° downward: Hard Spike!
    const target = new THREE.Vector3(
      lateralAim.x * 1.15 + badHitOffset,
      netPlaneY - 0.015 + netDropOffset,
      lateralAim.z * 1.15 + badHitOffset
    );
    if (quality === 'Early' && zone !== 'red') {
      const velocity = computeBallisticVelocity(ballPos, target, 0.54);
      velocity.x *= 0.45;
      velocity.z *= 0.45;
      velocity.y = Math.min(-3.8, velocity.y - 2.2);
      return {
        velocity,
        timing: quality,
        anim: 'spike',
        isAttackAtNet: true,
        triggeredDive: shouldAutoDive,
      };
    }
    const spikeT = THREE.MathUtils.clamp(
      (0.18 + distToNet * 0.025) / powerRatio - lowHeightFactor * 0.08,
      0.11,
      0.28
    );
    return {
      velocity: computeBallisticVelocity(ballPos, target, spikeT),
      timing: quality,
      anim: 'spike',
      isAttackAtNet: true,
      triggeredDive: shouldAutoDive,
    };
  }

  public static resolveServeToss(server: CharacterController): THREE.Vector3 {
    // Clean waist-to-shoulder serve toss (peaks around ~1.55 m so sweet-spot strikes stay legal)
    const toNet = new THREE.Vector3(-server.position.x, 0, -server.position.z).normalize();
    return new THREE.Vector3(toNet.x * 0.25, 3.35, toNet.z * 0.25);
  }

  public static resolveServeStrike(
    server: CharacterController,
    ballPos: THREE.Vector3,
    swipe: SwipeEvent,
    meterValue: number,
    camRight = new THREE.Vector3(1, 0, 0)
  ): { velocity: THREE.Vector3; quality: TimingQuality; isShank: boolean } {
    // Sweet spot is 0.35 .. 0.65 on the 0..1 golf meter
    const distFromCenter = Math.abs(meterValue - 0.5);
    const inSweetSpot = distFromCenter <= 0.15;
    const quality: TimingQuality =
      distFromCenter <= 0.065 ? 'Perfect' : inSweetSpot ? 'Early' : 'Late';

    const swipeLen = Math.max(1, swipe.distancePx);
    const dirX = swipe.dx / swipeLen;
    const dirY = swipe.dy / swipeLen;
    const powerMod = server.config.profile.stats.power;
    const longMod = server.config.profile.stats.longGame;
    const netPlaneY = OFFICIAL_NET.netHeight + OFFICIAL_BALL.radius;

    const lateral = camRight.clone().setY(0).normalize().multiplyScalar(dirX * 0.24);

    if (!inSweetSpot) {
      // Shank / bad angle / rim or miss
      const shankSide = camRight
        .clone()
        .setY(0)
        .normalize()
        .multiplyScalar((meterValue - 0.5) * 1.45);
      const target = new THREE.Vector3(
        shankSide.x + lateral.x,
        netPlaneY + (dirY < -0.3 ? 0.38 : -0.06),
        shankSide.z + lateral.z
      );
      return {
        velocity: computeBallisticVelocity(ballPos, target, 0.5),
        quality,
        isShank: true,
      };
    }

    const spread = quality === 'Perfect' ? 0.03 : 0.1 / longMod;
    const target = new THREE.Vector3(
      lateral.x + (Math.random() - 0.5) * spread,
      netPlaneY,
      lateral.z + (Math.random() - 0.5) * spread
    );

    // Calibrated serve flight time so sweet-spot serves hit crisp and bounce legally (~0.95-1.35 m, < 1.65 m)
    // Higher ballPos.y uses a slightly quicker drive time so downward vy_in stays legal!
    const heightAdj = Math.max(0, ballPos.y - 1.25) * 0.08;
    const baseFlight = (dirY > 0.3 ? 0.29 : dirY < -0.3 ? 0.37 : 0.33) - heightAdj;
    const flightTime = THREE.MathUtils.clamp(baseFlight / (0.92 + 0.08 * powerMod), 0.24, 0.4);

    return {
      velocity: computeBallisticVelocity(ballPos, target, flightTime),
      quality,
      isShank: false,
    };
  }
}
