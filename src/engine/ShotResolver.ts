import * as THREE from 'three';
import { OFFICIAL_BALL, OFFICIAL_NET } from '../config/equipment';
import { CharacterController, AnimState } from './CharacterController';
import { SwipeEvent } from './InputManager';

export type TimingQuality = 'Early' | 'Perfect' | 'Late';

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
  public static evaluateTiming(
    player: CharacterController,
    ballPos: THREE.Vector3,
    _ballVel: THREE.Vector3
  ): TimingQuality {
    const dist = Math.hypot(ballPos.x - player.position.x, ballPos.z - player.position.z);
    if (ballPos.y > 1.82) return 'Early';
    if (ballPos.y < 0.4) return 'Late';
    if (dist <= 1.35 && ballPos.y >= 0.4 && ballPos.y <= 1.82) {
      return 'Perfect';
    }
    return ballPos.y > 1.45 ? 'Early' : 'Late';
  }

  public static resolveRallyShot(
    player: CharacterController,
    teammate: CharacterController | undefined,
    ballPos: THREE.Vector3,
    ballVel: THREE.Vector3,
    swipe: SwipeEvent,
    teamTouchesAfterThis: number,
    isFirstPossessionAfterServe: boolean,
    camRight = new THREE.Vector3(1, 0, 0)
  ): ShotOutcome | null {
    const horizDist = Math.hypot(ballPos.x - player.position.x, ballPos.z - player.position.z);
    const shouldAutoDive =
      player.isSprinting &&
      ballPos.y < 0.78 &&
      ballVel.y < -0.15 &&
      horizDist <= player.getEffectiveReach() + 0.65 &&
      horizDist > 0.55;

    const maxReach = player.getEffectiveReach() + (shouldAutoDive ? 0.55 : 0);
    // Can hit on the way up OR down unless ball is above hitting height!
    if (horizDist > maxReach || ballPos.y > MAX_HITTING_HEIGHT) {
      return null;
    }

    const timing = this.evaluateTiming(player, ballPos, ballVel);
    const timingSpread = timing === 'Perfect' ? 0.03 : 0.11;
    const shortMod = player.config.profile.stats.shortGame;
    const powerMod = player.config.profile.stats.power;

    const swipeLen = Math.max(1, swipe.distancePx);
    const swipeDirX = swipe.dx / swipeLen;
    const swipeDirY = swipe.dy / swipeLen; // negative = swipe UP
    const powerRatio = THREE.MathUtils.clamp(swipe.speedPxPerSec / 1200, 0.35, 1.25);

    const distToNet = Math.hypot(player.position.x, player.position.z);
    const netPlaneY = OFFICIAL_NET.netHeight + OFFICIAL_BALL.radius;

    const isSwipeUp = swipeDirY < -0.38;
    const isSwipeDown = swipeDirY > 0.38;

    // Lateral offset in camera-screen right direction
    const lateralAim = camRight.clone().setY(0).normalize().multiplyScalar(swipeDirX * 0.22);

    // Helper: clean high pass/set toward teammate near net (peaks ~2.2-2.5 m, drops at y = 1.2 m!)
    const buildSetToTeammate = (flightTime: number, anim: AnimState): ShotOutcome => {
      const setTarget = teammate
        ? teammate.position.clone().lerp(new THREE.Vector3(0, 0, 0), 0.32)
        : new THREE.Vector3(-player.position.x * 0.25, 0, -player.position.z * 0.25);
      // Keep set outside the 1.00 m NHZ so hitter can legally spike it
      const r = Math.hypot(setTarget.x, setTarget.z);
      if (r < 1.35 && r > 0.01) {
        setTarget.x = (setTarget.x / r) * 1.45;
        setTarget.z = (setTarget.z / r) * 1.45;
      }
      setTarget.x += lateralAim.x * 1.5 + (Math.random() - 0.5) * timingSpread;
      setTarget.z += lateralAim.z * 1.5 + (Math.random() - 0.5) * timingSpread;
      setTarget.y = 1.22;
      return {
        velocity: computeBallisticVelocity(ballPos, setTarget, flightTime),
        timing,
        anim,
        isAttackAtNet: false,
        triggeredDive: shouldAutoDive,
      };
    };

    // On Touch 1 of serve receive, always dig/pass cleanly to teammate so player doesn't accidentally fault!
    if (isFirstPossessionAfterServe && teamTouchesAfterThis === 1) {
      return buildSetToTeammate(0.96, isSwipeUp ? 'hit_high' : 'hit_low');
    }

    // 1. Overhead Spike (Swipe Down close to net, or any Swipe Down on Touch 3)
    if (isSwipeDown && (teamTouchesAfterThis >= 3 || distToNet < 2.4)) {
      const target = new THREE.Vector3(
        lateralAim.x * 1.25 + (Math.random() - 0.5) * timingSpread,
        netPlaneY - 0.015,
        lateralAim.z * 1.25 + (Math.random() - 0.5) * timingSpread
      );
      // Fast explosive spike into net -> pops high & shoots across court
      const flightTime = THREE.MathUtils.clamp(
        THREE.MathUtils.lerp(0.2, 0.14, Math.min(1, powerRatio * powerMod)) + distToNet * 0.025,
        0.14,
        0.28
      );
      return {
        velocity: computeBallisticVelocity(ballPos, target, flightTime),
        timing,
        anim: 'spike',
        isAttackAtNet: true,
        triggeredDive: shouldAutoDive,
      };
    }

    // 2. Context-Aware Swipe Up
    if (isSwipeUp) {
      const isFinalTouch = teamTouchesAfterThis >= 3;
      const closeToNet = distToNet < 1.65;

      // On Touch 3, Swipe Up ALWAYS arcs high toward the net as a rainbow / drop shot
      if (isFinalTouch || (!isFirstPossessionAfterServe && closeToNet && Math.abs(swipeDirX) < 0.4 && teamTouchesAfterThis === 2)) {
        const missBias = timing === 'Perfect' ? 0 : (Math.random() - 0.5) * (0.24 / shortMod);
        const target = new THREE.Vector3(
          lateralAim.x + missBias,
          netPlaneY,
          lateralAim.z + missBias
        );
        const flightTime = THREE.MathUtils.clamp(0.92 + distToNet * 0.12, 0.92, 1.38);
        return {
          velocity: computeBallisticVelocity(ballPos, target, flightTime),
          timing,
          anim: 'hit_high',
          isAttackAtNet: true,
          triggeredDive: shouldAutoDive,
        };
      }
      return buildSetToTeammate(1.0, 'hit_high');
    }

    // 3. Low-Angle / Sideways Swipe: Touch 3 -> Fast Drive at Net; Touch 1-2 -> Pass/Set to Teammate
    if (teamTouchesAfterThis >= 3 || (!isFirstPossessionAfterServe && distToNet < 1.85 && Math.abs(swipeDirX) < 0.5)) {
      const target = new THREE.Vector3(
        lateralAim.x * 1.15 + (Math.random() - 0.5) * timingSpread,
        netPlaneY,
        lateralAim.z * 1.15 + (Math.random() - 0.5) * timingSpread
      );
      const flightTime = THREE.MathUtils.clamp(0.2 + distToNet * 0.055, 0.19, 0.4);
      return {
        velocity: computeBallisticVelocity(ballPos, target, flightTime),
        timing,
        anim: 'hit_low',
        isAttackAtNet: true,
        triggeredDive: shouldAutoDive,
      };
    }

    return buildSetToTeammate(0.92, 'hit_low');
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
