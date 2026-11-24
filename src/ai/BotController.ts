import * as THREE from 'three';
import { OFFICIAL_NET } from '../config/equipment';
import { IRF_2026_RULES } from '../config/rules';
import { CharacterController } from '../engine/CharacterController';
import { MatchManager } from '../engine/MatchManager';
import { PhysicsWorld } from '../engine/PhysicsWorld';
import { computeBallisticVelocity } from '../engine/ShotResolver';

export class BotController {
  private readonly players: CharacterController[];
  private readonly physics: PhysicsWorld;
  private readonly match: MatchManager;
  private hitCooldowns = new Map<number, number>();

  constructor(players: CharacterController[], physics: PhysicsWorld, match: MatchManager) {
    this.players = players;
    this.physics = physics;
    this.match = match;
  }

  public update(dt: number): void {
    const ballPos = this.physics.getBallPosition();
    const phase = this.match.phase;

    for (const bot of this.players) {
      if (bot.isHuman) continue;
      const idx = bot.config.slotIndex;
      const cd = Math.max(0, (this.hitCooldowns.get(idx) ?? 0) - dt);
      this.hitCooldowns.set(idx, cd);

      const moveIntent = new THREE.Vector2(0, 0);
      let deflection = 0;

      const isLiveBall =
        phase === 'RALLY_LIVE' ||
        (phase === 'SERVE_IN_FLIGHT' && bot.team !== this.match.getServingTeam());

      if (isLiveBall) {
        const isMyTeamsTurn =
          phase === 'SERVE_IN_FLIGHT'
            ? bot.team !== this.match.getServingTeam()
            : this.match.possessionTeam === bot.team || this.match.teamTouches === 0;

        const canThisBotTouch =
          this.match.possessionTeam !== bot.team ||
          this.match.lastTouchPlayerIdx !== idx;

        if (isMyTeamsTurn && canThisBotTouch) {
          // Pick closest eligible bot on this team to the ball
          const teamBots = this.players.filter(
            (p) =>
              p.team === bot.team &&
              (this.match.possessionTeam !== p.team || this.match.lastTouchPlayerIdx !== p.config.slotIndex)
          );
          let closest = teamBots[0];
          let bestDist = Infinity;
          for (const candidate of teamBots) {
            const d = Math.hypot(
              candidate.position.x - ballPos.x,
              candidate.position.z - ballPos.z
            );
            if (d < bestDist) {
              bestDist = d;
              closest = candidate;
            }
          }

          if (closest === bot) {
            const dx = ballPos.x - bot.position.x;
            const dz = ballPos.z - bot.position.z;
            const dist = Math.hypot(dx, dz);

            if (dist > 0.35) {
              moveIntent.set(dx / dist, dz / dist);
              deflection = dist > 1.8 ? 0.88 : 0.5;
            }

            // Execute bot touch when ball is within reach and descending or playable height
            const reach = bot.getEffectiveReach() * 0.92;
            if (cd <= 0 && dist <= reach && ballPos.y >= 0.22 && ballPos.y <= 1.85) {
              this.performBotShot(bot, ballPos);
              this.hitCooldowns.set(idx, 0.45);
            }
          } else {
            this.moveToSupportPosition(bot, moveIntent);
            deflection = 0.48;
          }
        } else {
          this.moveToSupportPosition(bot, moveIntent);
          deflection = 0.48;
        }
      } else {
        // Hold idle / ready position during serve wait
        this.moveToSupportPosition(bot, moveIntent, 0.25);
        deflection = moveIntent.length() > 0.1 ? 0.4 : 0;
      }

      const isPreServe =
        phase === 'SERVE_WAIT_TOSS' || phase === 'SERVE_METER_ACTIVE';
      bot.update(dt, moveIntent, deflection, isPreServe);
    }
  }

  private moveToSupportPosition(
    bot: CharacterController,
    outIntent: THREE.Vector2,
    deadzone = 0.35
  ): void {
    const target = new THREE.Vector3(...bot.config.startPos);
    const dx = target.x - bot.position.x;
    const dz = target.z - bot.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist > deadzone) {
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
      nextTouches >= 2 &&
      Math.hypot(bot.position.x, bot.position.z) < 1.9 &&
      Math.random() < 0.35;

    if (mustAttack || canAttackEarly) {
      // Respect 1.00 m NHZ: if bot is inside NHZ, step back or lob safely
      const distNet = Math.hypot(bot.position.x, bot.position.z);
      if (distNet < IRF_2026_RULES.noHitZoneRadius + 0.05) {
        const pushOut = (IRF_2026_RULES.noHitZoneRadius + 0.15) / Math.max(0.01, distNet);
        bot.position.x *= pushOut;
        bot.position.z *= pushOut;
      }
      const target = new THREE.Vector3(
        (Math.random() - 0.5) * 0.26,
        OFFICIAL_NET.netHeight,
        (Math.random() - 0.5) * 0.26
      );
      const flightTime = THREE.MathUtils.clamp(0.32 + distNet * 0.12, 0.3, 0.72);
      const vel = computeBallisticVelocity(ballPos, target, flightTime);
      this.match.handleBotTouch(bot, vel, true);
    } else {
      // Set toward teammate (leaning slightly toward center net for a clean attack)
      const setTarget = teammate
        ? teammate.position.clone().lerp(new THREE.Vector3(0, 0, 0), 0.35)
        : new THREE.Vector3(0, 0, 0);
      setTarget.y = 1.45;
      const vel = computeBallisticVelocity(ballPos, setTarget, 0.95);
      this.match.handleBotTouch(bot, vel, false);
    }
  }
}
