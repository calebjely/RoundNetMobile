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
 * Computes ballistic velocity from P0 -> P1 in flightTime seconds under softened gravity,
 * with a small compensation factor for air drag.
 */
export function computeBallisticVelocity(
  from: THREE.Vector3,
  to: THREE.Vector3,
  flightTime: number
): THREE.Vector3 {
  const t = Math.max(0.18, flightTime);
  const g = OFFICIAL_BALL.gravity; // negative
  const dragComp = 1 + OFFICIAL_BALL.linearDamping * 0.45 * t;
  const vx = ((to.x - from.x) / t) * dragComp;
  const vz = ((to.z - from.z) / t) * dragComp;
  const vy = (to.y - from.y - 0.5 * g * t * t) / t;
  return new THREE.Vector3(vx, vy, vz);
}

export class ShotResolver {
  public static evaluateTiming(
    player: CharacterController,
    ballPos: THREE.Vector3,
    ballVel: THREE.Vector3
  ): TimingQuality {
    const dist = player.position.distanceTo(
      new THREE.Vector3(ballPos.x, player.position.y, ballPos.z)
    );
    const idealDist = 0.65;
    if (ballPos.y > 1.55 && ballVel.y > 0.5) return 'Early';
    if (ballPos.y < 0.38 && ballVel.y < -0.5) return 'Late';
    if (Math.abs(dist - idealDist) < 0.42 && ballPos.y >= 0.45 && ballPos.y <= 1.55) {
      return 'Perfect';
    }
    return ballPos.y > 1.25 ? 'Early' : 'Late';
  }

  public static resolveRallyShot(
    player: CharacterController,
    teammate: CharacterController | undefined,
    ballPos: THREE.Vector3,
    ballVel: THREE.Vector3,
    swipe: SwipeEvent,
    teamTouchesAfterThis: number
  ): ShotOutcome | null {
    const horizDist = Math.hypot(ballPos.x - player.position.x, ballPos.z - player.position.z);
    const shouldAutoDive =
      player.isSprinting &&
      ballPos.y < 0.72 &&
      ballVel.y < -0.2 &&
      horizDist <= player.getEffectiveReach() + 0.55 &&
      horizDist > 0.45;

    const maxReach = player.getEffectiveReach() + (shouldAutoDive ? 0.45 : 0);
    if (horizDist > maxReach || ballPos.y > 2.45) {
      return null;
    }

    const timing = this.evaluateTiming(player, ballPos, ballVel);
    const timingSpread = timing === 'Perfect' ? 0.04 : 0.16;
    const shortMod = player.config.profile.stats.shortGame;
    const powerMod = player.config.profile.stats.power;

    const swipeLen = Math.max(1, swipe.distancePx);
    const swipeDirX = swipe.dx / swipeLen;
    const swipeDirY = swipe.dy / swipeLen; // negative = swipe UP on screen
    const powerRatio = THREE.MathUtils.clamp(swipe.speedPxPerSec / 1350, 0.3, 1.25);

    const distToNet = Math.hypot(player.position.x, player.position.z);
    const toNet = new THREE.Vector3(-player.position.x, 0, -player.position.z).normalize();

    const isSwipeUp = swipeDirY < -0.45;
    const isSwipeDown = swipeDirY > 0.45;

    // 1. Overhead Spike (Swipe Down close to net)
    if (isSwipeDown && distToNet < 2.25) {
      const aimOffsetX = swipeDirX * 0.25;
      const target = new THREE.Vector3(
        aimOffsetX + (Math.random() - 0.5) * timingSpread,
        OFFICIAL_NET.netHeight - 0.02,
        (Math.random() - 0.5) * timingSpread
      );
      const flightTime = THREE.MathUtils.lerp(0.28, 0.19, Math.min(1, powerRatio * powerMod));
      const velocity = computeBallisticVelocity(ballPos, target, flightTime);
      return {
        velocity,
        timing,
        anim: 'spike',
        isAttackAtNet: true,
        triggeredDive: shouldAutoDive,
      };
    }

    // 2. Context-Aware Swipe Up
    if (isSwipeUp) {
      const isFinalTouch = teamTouchesAfterThis >= 3;
      const teammateDir = teammate
        ? new THREE.Vector3(
            teammate.position.x - player.position.x,
            0,
            teammate.position.z - player.position.z
          ).normalize()
        : toNet;

      // On Touch 3, Swipe Up ALWAYS arcs toward the net as a high rainbow / drop shot
      // On Touches 1-2, favor Set toward teammate unless very close to net & aiming inward
      const closeToNet = distToNet < 1.55;
      if (isFinalTouch || (closeToNet && Math.abs(swipeDirX) < 0.45 && teamTouchesAfterThis === 2)) {
        const missBias = timing === 'Perfect' ? 0 : (Math.random() - 0.5) * (0.35 / shortMod);
        const target = new THREE.Vector3(
          swipeDirX * 0.28 + missBias,
          OFFICIAL_NET.netHeight,
          missBias
        );
        const flightTime = THREE.MathUtils.clamp(0.65 + distToNet * 0.14, 0.65, 1.35);
        const velocity = computeBallisticVelocity(ballPos, target, flightTime);
        return {
          velocity,
          timing,
          anim: 'hit_high',
          isAttackAtNet: true,
          triggeredDive: shouldAutoDive,
        };
      } else {
        // High Set toward teammate (or center-court sweet spot near net)
        const setTarget = teammate
          ? teammate.position
              .clone()
              .lerp(new THREE.Vector3(0, 0, 0), 0.35)
              .add(new THREE.Vector3(swipeDirX * 0.6, 1.35, 0))
          : new THREE.Vector3(
              toNet.x * 0.8 + teammateDir.x * 0.5,
              1.35,
              toNet.z * 0.8 + teammateDir.z * 0.5
            );
        setTarget.x += (Math.random() - 0.5) * timingSpread * 1.5;
        setTarget.z += (Math.random() - 0.5) * timingSpread * 1.5;
        const velocity = computeBallisticVelocity(ballPos, setTarget, 0.92);
        return {
          velocity,
          timing,
          anim: 'hit_high',
          isAttackAtNet: false,
          triggeredDive: shouldAutoDive,
        };
      }
    }

    // 3. Low-Angle Swipe: Quick Pass to Teammate or Flat Drive at Net
    if (teamTouchesAfterThis >= 3 || (distToNet < 1.9 && Math.abs(swipeDirX) < 0.55)) {
      // Aggressive low drive toward net (risks rim/side if too flat!)
      const target = new THREE.Vector3(
        swipeDirX * 0.32 + (Math.random() - 0.5) * timingSpread,
        OFFICIAL_NET.netHeight + (powerRatio > 1.05 ? -0.03 : 0.01),
        (Math.random() - 0.5) * timingSpread
      );
      const flightTime = THREE.MathUtils.clamp(0.32 + distToNet * 0.08, 0.26, 0.68);
      const velocity = computeBallisticVelocity(ballPos, target, flightTime);
      return {
        velocity,
        timing,
        anim: 'hit_low',
        isAttackAtNet: true,
        triggeredDive: shouldAutoDive,
      };
    }

    // Quick pass toward teammate
    const passTarget = teammate
      ? teammate.position.clone().lerp(new THREE.Vector3(0, 0, 0), 0.25)
      : toNet.clone().multiplyScalar(1.2);
    passTarget.y = 1.05;
    passTarget.x += swipeDirX * 0.55;
    const velocity = computeBallisticVelocity(ballPos, passTarget, 0.66);
    return {
      velocity,
      timing,
      anim: 'hit_low',
      isAttackAtNet: false,
      triggeredDive: shouldAutoDive,
    };
  }

  public static resolveServeToss(server: CharacterController): THREE.Vector3 {
    // Pop ball cleanly upward for 2-step serve
    const tossVel = new THREE.Vector3(
      -server.position.x * 0.08,
      5.25,
      -server.position.z * 0.08
    );
    return tossVel;
  }

  public static resolveServeStrike(
    server: CharacterController,
    ballPos: THREE.Vector3,
    swipe: SwipeEvent,
    meterValue: number
  ): { velocity: THREE.Vector3; quality: TimingQuality; isShank: boolean } {
    // Sweet spot is 0.38 .. 0.62 on the 0..1 golf meter
    const distFromCenter = Math.abs(meterValue - 0.5);
    const inSweetSpot = distFromCenter <= 0.13;
    const quality: TimingQuality =
      distFromCenter <= 0.055 ? 'Perfect' : inSweetSpot ? 'Early' : 'Late';

    const swipeLen = Math.max(1, swipe.distancePx);
    const dirX = swipe.dx / swipeLen;
    const dirY = swipe.dy / swipeLen;
    const powerMod = server.config.profile.stats.power;
    const longMod = server.config.profile.stats.longGame;

    if (!inSweetSpot) {
      // Shank / bad angle / net miss
      const shankOffset = (meterValue - 0.5) * 2.2;
      const target = new THREE.Vector3(
        shankOffset + dirX * 0.55,
        OFFICIAL_NET.netHeight + (dirY < -0.3 ? 0.35 : -0.06),
        (Math.random() - 0.5) * 0.45
      );
      return {
        velocity: computeBallisticVelocity(ballPos, target, 0.46),
        quality,
        isShank: true,
      };
    }

    const spread = quality === 'Perfect' ? 0.04 : 0.14 / longMod;
    const target = new THREE.Vector3(
      dirX * 0.24 + (Math.random() - 0.5) * spread,
      OFFICIAL_NET.netHeight,
      (Math.random() - 0.5) * spread
    );

    // Swipe down = fast drive serve; swipe up = higher arc serve
    const baseFlight = dirY > 0.3 ? 0.36 : dirY < -0.3 ? 0.54 : 0.43;
    const flightTime = baseFlight / (0.9 + 0.1 * powerMod);

    return {
      velocity: computeBallisticVelocity(ballPos, target, flightTime),
      quality,
      isShank: false,
    };
  }
}
