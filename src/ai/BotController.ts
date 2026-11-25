import * as THREE from 'three';
import { OFFICIAL_BALL, OFFICIAL_NET } from '../config/equipment';
import { IRF_2026_RULES } from '../config/rules';
import { CharacterController } from '../engine/CharacterController';
import { MatchManager } from '../engine/MatchManager';
import { PhysicsWorld } from '../engine/PhysicsWorld';
import {
  computeBallisticVelocity,
  MAX_HITTING_HEIGHT,
  predictBallIntercept,
} from '../engine/ShotResolver';

export class BotController {
  private readonly players: CharacterController[];
  private readonly physics: PhysicsWorld;
  private readonly match: MatchManager;
  private hitCooldowns = new Map<number, number>();
  private globalTouchCooldown = 0;
  private reactionDelay = 0;
  private prevPossessionTeam: string = '';
  private prevTeamTouches = -1;

  constructor(players: CharacterController[], physics: PhysicsWorld, match: MatchManager) {
    this.players = players;
    this.physics = physics;
    this.match = match;
  }

  public update(dt: number, playerSpeedMult = 1.0): void {
    this.globalTouchCooldown = Math.max(0, this.globalTouchCooldown - dt);
    if (
      this.match.possessionTeam !== this.prevPossessionTeam ||
      this.match.teamTouches !== this.prevTeamTouches
    ) {
      // Realistic human-like ~0.28s reaction window when possession flips off the net
      if (this.match.teamTouches === 0 && this.match.phase === 'RALLY_LIVE') {
        this.reactionDelay = 0.28;
      }
      this.prevPossessionTeam = this.match.possessionTeam;
      this.prevTeamTouches = this.match.teamTouches;
    }
    this.reactionDelay = Math.max(0, this.reactionDelay - dt);

    const ballPos = this.physics.getBallPosition();
    const ballVel = this.physics.getBallVelocity();
    const phase = this.match.phase;

    // Predict where the ball will arrive at strike height (y = 1.05 m)
    const intercept = predictBallIntercept(ballPos, ballVel, 1.05);

    for (const bot of this.players) {
      if (bot.isHuman) continue;
      this.stepAutoMovement(bot, dt, playerSpeedMult, ballPos, ballVel, phase, intercept, false);
    }
  }

  /**
   * Auto-moves the human player in 1st-Person Auto-Runner mode (never auto-hits; user swipes to hit).
   */
  public updateHumanAutoMove(
    dt: number,
    playerSpeedMult = 1.0,
    stance: 'close' | 'away' = 'close'
  ): void {
    const human = this.players.find((p) => p.isHuman);
    if (!human) return;
    const ballPos = this.physics.getBallPosition();
    const ballVel = this.physics.getBallVelocity();
    const intercept = predictBallIntercept(ballPos, ballVel, 1.05);
    this.stepAutoMovement(
      human,
      dt,
      playerSpeedMult,
      ballPos,
      ballVel,
      this.match.phase,
      intercept,
      true,
      stance
    );
  }

  private stepAutoMovement(
    bot: CharacterController,
    dt: number,
    playerSpeedMult: number,
    ballPos: THREE.Vector3,
    _ballVel: THREE.Vector3,
    phase: string,
    intercept: { x: number; z: number; time: number },
    movementOnly: boolean,
    stance: 'close' | 'away' = 'close'
  ): void {
      const idx = bot.config.slotIndex;
      const cd = Math.max(0, (this.hitCooldowns.get(idx) ?? 0) - dt);
      this.hitCooldowns.set(idx, cd);

      const moveIntent = new THREE.Vector2(0, 0);
      let deflection = 0;

      const isServeRebounded =
        phase === 'SERVE_IN_FLIGHT' &&
        this.match.serveReboundedOffNet &&
        bot.team !== this.match.getServingTeam();

      const isLiveBall = phase === 'RALLY_LIVE' || isServeRebounded;

      if (isLiveBall) {
        const isMyTeamsTurn = isServeRebounded
          ? true
          : this.match.possessionTeam === bot.team;

        const canThisBotTouch =
          isServeRebounded ||
          this.match.possessionTeam !== bot.team ||
          this.match.lastTouchPlayerIdx !== idx;

        if (isMyTeamsTurn && canThisBotTouch) {
          // Pick closest eligible player on this team to the PREDICTED intercept point
          const eligible = this.players.filter(
            (p) =>
              p.team === bot.team &&
              (isServeRebounded ||
                this.match.possessionTeam !== p.team ||
                this.match.lastTouchPlayerIdx !== p.config.slotIndex)
          );
          let closest = eligible[0];
          let bestDist = Infinity;
          for (const candidate of eligible) {
            const d = Math.hypot(
              candidate.position.x - intercept.x,
              candidate.position.z - intercept.z
            );
            if (d < bestDist) {
              bestDist = d;
              closest = candidate;
            }
          }

          if (closest === bot) {
            if (movementOnly || this.reactionDelay <= 0) {
              const dx = intercept.x - bot.position.x;
              const dz = intercept.z - bot.position.z;
              const distToIntercept = Math.hypot(dx, dz);

              // In 1st-person auto-runner, stop ~0.92 m shy of the ball so it drops cleanly in front of view
              const stopDist = movementOnly ? 0.92 : 0.25;
              if (distToIntercept > stopDist) {
                moveIntent.set(dx / distToIntercept, dz / distToIntercept);
                deflection = movementOnly
                  ? distToIntercept > 1.85 ? 0.9 : 0.56
                  : distToIntercept > 1.3 ? 0.68 : 0.42;
              }
            }

            if (!movementOnly) {
              // Can hit on the way up OR down unless ball is above hitting height!
              const actualDist = Math.hypot(
                ballPos.x - bot.position.x,
                ballPos.z - bot.position.z
              );
              const reach = bot.getEffectiveReach() * 0.58;
              const ballPlayable = ballPos.y >= 0.22 && ballPos.y <= MAX_HITTING_HEIGHT;

              if (
                cd <= 0 &&
                this.globalTouchCooldown <= 0 &&
                actualDist <= reach &&
                ballPlayable
              ) {
                this.performBotShot(bot, ballPos);
                this.hitCooldowns.set(idx, 0.55);
                this.globalTouchCooldown = 0.25;
              }
            }
          } else {
            this.moveToAttackReadySpot(bot, moveIntent, bot.isHuman ? stance : undefined);
            deflection = moveIntent.length() > 0.1 ? 0.55 : 0;
          }
        } else {
          this.moveToDefensiveSpot(bot, ballPos, moveIntent, bot.isHuman ? stance : undefined);
          for (const other of this.players) {
            if (other.team === bot.team) continue;
            const odx = bot.position.x - other.position.x;
            const odz = bot.position.z - other.position.z;
            const od = Math.hypot(odx, odz);
            if (od < 1.35 && od > 0.01) {
              moveIntent.x += (odx / od) * 1.4;
              moveIntent.y += (odz / od) * 1.4;
            }
          }
          if (moveIntent.lengthSq() > 0.01) moveIntent.normalize();
          deflection = moveIntent.length() > 0.1 ? 0.54 : 0;
        }
      } else if (phase === 'SERVE_WAIT_TOSS' || phase === 'SERVE_METER_ACTIVE') {
        this.moveToStartSpot(bot, moveIntent, 0.22);
        deflection = moveIntent.length() > 0.1 ? 0.45 : 0;
      }

      const isPreServe =
        phase === 'SERVE_WAIT_TOSS' || phase === 'SERVE_METER_ACTIVE';
      const effectiveSpeed = movementOnly ? playerSpeedMult : playerSpeedMult * 0.82;
      bot.update(dt, moveIntent, deflection, isPreServe, effectiveSpeed);
  }

  private moveToStartSpot(
    bot: CharacterController,
    outIntent: THREE.Vector2,
    deadzone = 0.25
  ): void {
    const target = new THREE.Vector3(...bot.config.startPos);
    const dx = target.x - bot.position.x;
    const dz = target.z - bot.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist > deadzone) {
      outIntent.set(dx / dist, dz / dist);
    }
  }

  private moveToAttackReadySpot(
    bot: CharacterController,
    outIntent: THREE.Vector2,
    stance?: 'close' | 'away'
  ): void {
    // Move to attack-ready spot in quarter (Close/Away adjusts human auto-runner depth)
    const radius = stance === 'away' ? 2.15 : stance === 'close' ? 1.42 : 1.65;
    const angle = bot.config.quarterCenterAngle;
    const tx = Math.sin(angle) * radius;
    const tz = Math.cos(angle) * radius;
    const dx = tx - bot.position.x;
    const dz = tz - bot.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 0.3) {
      outIntent.set(dx / dist, dz / dist);
    }
  }

  private moveToDefensiveSpot(
    bot: CharacterController,
    ballPos: THREE.Vector3,
    outIntent: THREE.Vector2,
    stance?: 'close' | 'away'
  ): void {
    // Position ~2.7 m from net biased opposite the ball so defenders cover spikes
    const ballAngle = Math.atan2(ballPos.x, ballPos.z);
    const baseAngle = bot.config.quarterCenterAngle;
    // Slight shift away from ball without collapsing onto teammate
    let diff = ballAngle - baseAngle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const defAngle = baseAngle - Math.sign(diff) * 0.18;

    const radius = stance === 'away' ? 3.2 : stance === 'close' ? 2.2 : 2.75;
    const tx = Math.sin(defAngle) * radius;
    const tz = Math.cos(defAngle) * radius;
    const dx = tx - bot.position.x;
    const dz = tz - bot.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 0.35) {
      outIntent.set(dx / dist, dz / dist);
    }
  }

  private performBotShot(bot: CharacterController, ballPos: THREE.Vector3): void {
    const nextTouches =
      this.match.phase === 'SERVE_IN_FLIGHT' || this.match.possessionTeam !== bot.team
        ? 1
        : this.match.teamTouches + 1;

    const teammate = this.players.find(
      (p) => p.team === bot.team && p.config.slotIndex !== bot.config.slotIndex
    );

    const mustAttack = nextTouches >= 3;
    const canAttackEarly =
      !this.match.isFirstPossessionAfterServe &&
      nextTouches === 2 &&
      Math.hypot(bot.position.x, bot.position.z) < 1.85 &&
      Math.random() < 0.25;

    const netPlaneY = OFFICIAL_NET.netHeight + OFFICIAL_BALL.radius;

    if (mustAttack || canAttackEarly) {
      // Respect 1.00 m NHZ
      const distNet = Math.hypot(bot.position.x, bot.position.z);
      if (distNet < IRF_2026_RULES.noHitZoneRadius + 0.08) {
        const pushOut = (IRF_2026_RULES.noHitZoneRadius + 0.16) / Math.max(0.01, distNet);
        bot.position.x *= pushOut;
        bot.position.z *= pushOut;
      }

      // Mix hard spikes (75%) and high rainbow drop shots (25%)
      const isDropShot = Math.random() < 0.25;
      const cutX = (Math.random() - 0.5) * 0.32;
      const cutZ = (Math.random() - 0.5) * 0.32;
      const target = new THREE.Vector3(cutX, netPlaneY - 0.01, cutZ);

      const flightTime = isDropShot
        ? THREE.MathUtils.clamp(0.88 + distNet * 0.1, 0.88, 1.25)
        : THREE.MathUtils.clamp(0.14 + distNet * 0.04, 0.14, 0.28);
      const vel = computeBallisticVelocity(ballPos, target, flightTime);
      this.match.handleBotTouch(bot, vel, true);
    } else {
      // High readable set to teammate (arrives at y = 1.22 m after ~0.95 s -> peaks at ~2.35 m!)
      const setTarget = teammate
        ? teammate.position.clone().lerp(new THREE.Vector3(0, 0, 0), 0.3)
        : new THREE.Vector3(0, 0, 0);
      const r = Math.hypot(setTarget.x, setTarget.z);
      if (r < 1.35 && r > 0.01) {
        setTarget.x = (setTarget.x / r) * 1.45;
        setTarget.z = (setTarget.z / r) * 1.45;
      }
      setTarget.y = 1.22;
      const flightTime = nextTouches === 1 ? 0.94 : 0.98;
      const vel = computeBallisticVelocity(ballPos, setTarget, flightTime);
      this.match.handleBotTouch(bot, vel, false);
    }
  }
}
