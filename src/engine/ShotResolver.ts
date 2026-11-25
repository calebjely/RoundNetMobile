import * as THREE from 'three';
import { OFFICIAL_BALL, OFFICIAL_NET } from '../config/equipment';
import { CharacterController, AnimState } from './CharacterController';
import { SwipeEvent } from './InputManager';

export type TimingQuality = 'Early' | 'Perfect' | 'Late' | 'Bad';
export type ContactZone = 'green' | 'yellow' | 'red';
export type SwipeShotType = 'HIGH' | 'LOW' | 'SPIKE';

export interface ContactTiming {
  offset: number;
  quality01: number;
  zone: ContactZone;
  timing: TimingQuality;
  ringProgress: number;
}

export interface ShotOutcome {
  velocity: THREE.Vector3;
  timing: TimingQuality;
  zone: ContactZone;
  shotType: SwipeShotType;
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
  public static evaluateContactTiming(
    ballPos: THREE.Vector3,
    ballVel: THREE.Vector3,
    playerPos: THREE.Vector3
  ): ContactTiming {
    const SWEET_Y = 1.08;
    const g = OFFICIAL_BALL.gravity;
    const dx = playerPos.x - ballPos.x;
    const dz = playerPos.z - ballPos.z;
    const horizDist = Math.hypot(dx, dz);

    const approachSpeed =
      horizDist > 0.01 ? (ballVel.x * dx + ballVel.z * dz) / horizDist : 0;
    let tHoriz = 0;
    if (horizDist > 0.72 && approachSpeed > 0.45) {
      tHoriz = Math.max(0, (horizDist - 0.65) / approachSpeed);
    } else if (horizDist > 1.35) {
      tHoriz = (horizDist - 1.25) * 0.25;
    }

    const disc = ballVel.y * ballVel.y - 2 * g * (SWEET_Y - ballPos.y);
    let dtVert = 0;
    if (ballPos.y > MAX_HITTING_HEIGHT) {
      const tDrop = disc >= 0 ? (ballVel.y + Math.sqrt(disc)) / g : 0.32;
      dtVert = Math.max(0.18, tDrop * 0.85);
    } else if (ballPos.y >= 0.65) {
      if (ballPos.y >= SWEET_Y) {
        if (ballVel.y <= 0) {
          dtVert = disc >= 0 ? (ballVel.y + Math.sqrt(disc)) / g : (ballPos.y - SWEET_Y) / 3.0;
        } else {
          // Rising through upper hitting window (legal to hit on the way up unless too high)
          dtVert = (ballPos.y - SWEET_Y) * 0.28;
        }
      } else if (ballVel.y > 0) {
        dtVert = ((SWEET_Y - ballPos.y) / Math.max(1.5, ballVel.y)) * 0.55;
      } else {
        dtVert = (ballPos.y - SWEET_Y) / Math.max(2.2, Math.abs(ballVel.y));
      }
    } else {
      if (ballVel.y > 0.5) {
        dtVert = ((SWEET_Y - ballPos.y) / Math.max(2.0, ballVel.y)) * 0.5;
      } else {
        dtVert = -((SWEET_Y - ballPos.y) / 2.6);
      }
    }

    const signedDt = tHoriz > 0.08 ? Math.max(tHoriz, dtVert) : dtVert;
    const outOfSweetRange =
      ballPos.y > MAX_HITTING_HEIGHT + 0.08 ||
      ballPos.y < 0.24 ||
      horizDist > 1.75;

    let zone: ContactZone;
    let timing: TimingQuality;
    if (outOfSweetRange) {
      zone = 'red';
      timing = 'Bad';
    } else if (signedDt >= -0.095 && signedDt <= 0.115) {
      zone = 'green';
      timing = 'Perfect';
    } else if (signedDt >= -0.22 && signedDt <= 0.25) {
      zone = 'yellow';
      timing = signedDt > 0 ? 'Early' : 'Late';
    } else {
      zone = 'red';
      timing = 'Bad';
    }

    return {
      offset: THREE.MathUtils.clamp(-signedDt / 0.35, -1, 1),
      quality01: THREE.MathUtils.clamp(1 - Math.abs(signedDt) / 0.34, 0.05, 1),
      zone,
      timing,
      ringProgress: THREE.MathUtils.clamp(0.5 + signedDt / 0.6, 0, 1),
    };
  }

  public static evaluateTiming(
    player: CharacterController,
    ballPos: THREE.Vector3,
    ballVel: THREE.Vector3
  ): TimingQuality {
    return this.evaluateContactTiming(ballPos, ballVel, player.position).timing;
  }

  public static resolveRallyShot(
    player: CharacterController,
    teammate: CharacterController | undefined,
    ballPos: THREE.Vector3,
    ballVel: THREE.Vector3,
    swipe: SwipeEvent,
    teamTouchesAfterThis: number,
    isFirstPossessionAfterServe: boolean,
    camRight = new THREE.Vector3(1, 0, 0),
    precomputedTiming?: ContactTiming
  ): ShotOutcome | null {
    const horizDist = Math.hypot(ballPos.x - player.position.x, ballPos.z - player.position.z);
    const baseReach = player.getEffectiveReach();
    // Auto-dive ONLY when ball is slightly out of normal reach and player swipes
    const shouldAutoDive =
      horizDist > baseReach * 0.92 &&
      horizDist <= baseReach + 0.85 &&
      ballPos.y <= MAX_HITTING_HEIGHT + 0.12;

    const maxReach = baseReach + (shouldAutoDive ? 0.85 : 0);
    // Can hit on the way up OR down unless ball is above hitting height!
    if (horizDist > maxReach || ballPos.y > MAX_HITTING_HEIGHT + 0.12) {
      return null;
    }

    const contact =
      precomputedTiming ?? this.evaluateContactTiming(ballPos, ballVel, player.position);
    const { timing, zone, offset } = contact;

    const swipeLen = Math.max(1, swipe.distancePx);
    const swipeDirX = swipe.dx / swipeLen;
    const swipeDirY = swipe.dy / swipeLen; // negative = UP on screen

    // Screen swipe angle from straight up: 0 = UP, pi/2 = SIDE, pi = DOWN
    const angleFromUp = Math.atan2(Math.abs(swipe.dx), -swipe.dy);
    const shotType: SwipeShotType =
      angleFromUp <= Math.PI / 4
        ? 'HIGH'
        : angleFromUp >= Math.PI * 0.67
          ? 'SPIKE'
          : 'LOW';

    // Swipe speed -> strength (0.25 soft touch .. 1.0 blistering whip)
    const power01 = THREE.MathUtils.clamp((swipe.speedPxPerSec - 240) / 1400, 0.25, 1.0);
    const powerMod = player.config.profile.stats.power;
    const shortMod = player.config.profile.stats.shortGame;

    const distToNet = Math.hypot(ballPos.x, ballPos.z);
    const netPlaneY = OFFICIAL_NET.netHeight + OFFICIAL_BALL.radius;

    const rightHoriz = camRight.clone().setY(0);
    if (rightHoriz.lengthSq() > 0.0001) rightHoriz.normalize();
    else rightHoriz.set(1, 0, 0);

    const toNet = new THREE.Vector3(-ballPos.x, 0, -ballPos.z);
    if (toNet.lengthSq() > 0.0001) toNet.normalize();
    else toNet.set(0, 0, -1);

    // Bad/Red timing adds scatter; Yellow adds minor scatter
    const scatterMag =
      zone === 'green' ? 0.025 : zone === 'yellow' ? 0.09 / shortMod : 0.34 / shortMod;
    const randScatterX = (Math.random() - 0.5) * 2 * scatterMag;
    const randScatterZ = (Math.random() - 0.5) * 2 * scatterMag;

    // 1. HIGH HIT / SET (90-degree upward cone: +-45 deg around UP)
    if (shotType === 'HIGH') {
      if (teamTouchesAfterThis <= 2) {
        const setTarget = teammate
          ? teammate.position.clone().lerp(new THREE.Vector3(0, 0, 0), 0.34)
          : new THREE.Vector3(-player.position.x * 0.25, 0, -player.position.z * 0.25);
        const r = Math.hypot(setTarget.x, setTarget.z);
        if (r < 1.38 && r > 0.01) {
          setTarget.x = (setTarget.x / r) * 1.48;
          setTarget.z = (setTarget.z / r) * 1.48;
        }
        setTarget.addScaledVector(rightHoriz, swipeDirX * 0.65);
        setTarget.x += randScatterX;
        setTarget.z += randScatterZ;
        setTarget.y = zone === 'red' ? 0.88 : 1.24;

        // Higher arc from faster up-swipe; timing shifts arc (early = higher, late = flatter)
        const baseFlight = THREE.MathUtils.lerp(0.86, 1.26, power01);
        const timingShift = -offset * 0.14; // offset < 0 (early) => +, offset > 0 (late) => -
        const flightTime = THREE.MathUtils.clamp(baseFlight + timingShift, 0.58, 1.42);
        return {
          velocity: computeBallisticVelocity(ballPos, setTarget, flightTime),
          timing,
          zone,
          shotType,
          anim: 'hit_high',
          isAttackAtNet: false,
          triggeredDive: shouldAutoDive,
        };
      }

      // Touch 3 HIGH lob onto the net
      const lobTarget = new THREE.Vector3(
        rightHoriz.x * swipeDirX * 0.26 + randScatterX,
        netPlaneY + (zone === 'red' ? -0.04 : 0),
        rightHoriz.z * swipeDirX * 0.26 + randScatterZ
      );
      const baseFlight = THREE.MathUtils.clamp(0.82 + power01 * 0.34 + distToNet * 0.08, 0.78, 1.42);
      const flightTime = THREE.MathUtils.clamp(baseFlight - offset * 0.18, 0.55, 1.5);
      return {
        velocity: computeBallisticVelocity(ballPos, lobTarget, flightTime),
        timing,
        zone,
        shotType,
        anim: 'hit_high',
        isAttackAtNet: true,
        triggeredDive: shouldAutoDive,
      };
    }

    // 2. SPIKE HIT (Downward cone: hard steep driven spike onto net)
    if (shotType === 'SPIKE') {
      // Later timing + low ball far from net pushes target lower onto front rim (harder to hit cleanly)
      const lateDropPenalty = offset > 0.15 ? offset * 0.12 : 0;
      const distPenalty = distToNet > 2.35 && ballPos.y < 0.9 ? 0.1 : 0;
      const lateralOffset = swipeDirX * 0.36;
      const depthAim = THREE.MathUtils.clamp((power01 - 0.5) * 0.22 - offset * 0.12, -0.26, 0.26);

      const target = new THREE.Vector3(
        rightHoriz.x * lateralOffset + toNet.x * depthAim + randScatterX * 1.15,
        netPlaneY - 0.02 - lateDropPenalty - distPenalty,
        rightHoriz.z * lateralOffset + toNet.z * depthAim + randScatterZ * 1.15
      );

      // Faster swipe = blistering faster downward flight; early keeps higher clearance
      const desiredSpeed = THREE.MathUtils.lerp(7.8, 13.8, Math.min(1, power01 * powerMod));
      const baseFlight = THREE.MathUtils.clamp(distToNet / desiredSpeed, 0.13, 0.38);
      const flightTime =
        offset < -0.25
          ? THREE.MathUtils.clamp(baseFlight * 1.55, 0.22, 0.52) // early pops higher off net
          : THREE.MathUtils.clamp(baseFlight * (1 - offset * 0.18), 0.12, 0.36);

      return {
        velocity: computeBallisticVelocity(ballPos, target, flightTime),
        timing,
        zone,
        shotType,
        anim: 'spike',
        isAttackAtNet: true,
        triggeredDive: shouldAutoDive,
      };
    }

    // 3. LOW HIT (Side-to-side & angled swipes: angle smoothly drives lob-vs-low cut)
    // elev01 ~ 1 near 46 deg up-side (lob toward net), ~ 0.45 at horizontal side-to-side (low cut), ~ 0.1 lower-side
    const elev01 = THREE.MathUtils.clamp((-swipeDirY + 0.52) / 1.22, 0, 1);
    const isAngledTeammateLob =
      (isFirstPossessionAfterServe && teamTouchesAfterThis === 1) ||
      (teamTouchesAfterThis <= 2 && elev01 > 0.62 && power01 < 0.72);

    if (isAngledTeammateLob) {
      // Mid-height angled lob drifting toward net / teammate side (less reliable than pure UP set)
      const anchor = teammate
        ? teammate.position.clone().lerp(new THREE.Vector3(0, 0, 0), 0.52)
        : new THREE.Vector3(0, 0, 0);
      anchor.addScaledVector(rightHoriz, swipeDirX * 0.55);
      anchor.x += randScatterX * 1.2;
      anchor.z += randScatterZ * 1.2;
      anchor.y = 0.96;
      const lobFlight = THREE.MathUtils.clamp(
        THREE.MathUtils.lerp(0.68, 0.96, elev01) - offset * 0.12,
        0.5,
        1.12
      );
      return {
        velocity: computeBallisticVelocity(ballPos, anchor, lobFlight),
        timing,
        zone,
        shotType,
        anim: 'hit_low',
        isAttackAtNet: false,
        triggeredDive: shouldAutoDive,
      };
    }

    // Low driven cut / angled pass directly at the net
    const lateralCut = swipeDirX * 0.38;
    const target = new THREE.Vector3(
      rightHoriz.x * lateralCut + toNet.x * (-offset * 0.08) + randScatterX,
      netPlaneY + (zone === 'red' ? -0.05 : offset > 0.25 ? -0.025 : 0),
      rightHoriz.z * lateralCut + toNet.z * (-offset * 0.08) + randScatterZ
    );
    const baseSpeed = THREE.MathUtils.lerp(6.4, 11.4, power01 * powerMod);
    const rawT = distToNet / baseSpeed;
    // Higher swipe angle -> slightly loftier lob; pure side-to-side + late -> flatter & lower
    const arcScale = THREE.MathUtils.lerp(0.88, 1.55, elev01);
    const timingScale = offset < 0 ? 1 + Math.abs(offset) * 0.28 : 1 - offset * 0.2;
    const flightTime = THREE.MathUtils.clamp(rawT * arcScale * timingScale, 0.17, 0.78);

    return {
      velocity: computeBallisticVelocity(ballPos, target, flightTime),
      timing,
      zone,
      shotType,
      anim: 'hit_low',
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
