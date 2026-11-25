import * as THREE from 'three';
import { MOVEMENT_TUNING, TeamId } from '../config/characters';
import { OFFICIAL_BALL, OFFICIAL_NET } from '../config/equipment';
import { IRF_2026_RULES } from '../config/rules';
import { CharacterController } from './CharacterController';
import { PhysicsWorld } from './PhysicsWorld';
import { computeBallisticVelocity, ShotResolver, TimingQuality } from './ShotResolver';
import { SwipeEvent } from './InputManager';

export type RallyPhase =
  | 'SERVE_WAIT_TOSS'
  | 'SERVE_METER_ACTIVE'
  | 'SERVE_IN_FLIGHT'
  | 'RALLY_LIVE'
  | 'POINT_OVER'
  | 'REDO_BANNER'
  | 'MATCH_OVER';

export interface TimingPopup {
  id: number;
  text: string;
  quality: TimingQuality | 'Info' | 'Fault' | 'Redo';
  screenX: number;
  screenY: number;
  createdAt: number;
}

export interface FeedEntry {
  id: number;
  text: string;
  tone: 'good' | 'warn' | 'bad' | 'info';
  createdAt: number;
}

export interface MatchHUDState {
  scoreA: number;
  scoreB: number;
  humanTeam: TeamId;
  pointsToWin: 15 | 21;
  servingTeam: TeamId;
  serverIndex: number;
  serverName: string;
  isHumanServing: boolean;
  serveAttempt: 1 | 2;
  servePointsRemaining: number;
  possessionTeam: TeamId;
  teamTouches: number;
  isFirstPossessionAfterServe: boolean;
  phase: RallyPhase;
  serveMeterValue: number;
  serveMeterActive: boolean;
  bannerText: string | null;
  bannerTone: 'info' | 'fault' | 'redo' | 'point';
  humanStamina: number;
  humanMaxStamina: number;
  humanExhausted: boolean;
  winner: TeamId | null;
}

export class MatchManager {
  public phase: RallyPhase = 'SERVE_WAIT_TOSS';
  public scoreA = 0;
  public scoreB = 0;
  public pointsToWin: 15 | 21 = IRF_2026_RULES.pointsToWin;

  // IRF Equal Serving Rotation: [0 (Team A), 2 (Team B), 1 (Team A), 3 (Team B)]
  private readonly serveRotation = [0, 2, 1, 3];
  private rotationCursor = 0;
  private isVeryFirstServeOfMatch = true;
  private servePointsRemaining = 1; // Equal Serving: 1st server of match gets 1 point
  private serveAttempt: 1 | 2 = 1;

  public possessionTeam: TeamId = 'A';
  public teamTouches = 0;
  public lastTouchPlayerIdx = -1;
  public lastAttackTeam: TeamId | null = null;
  public isFirstPossessionAfterServe = false;

  public serveHitNet = false;
  public serveReboundedOffNet = false;
  private servePeakAfterNet = 0;
  private serveFaultPendingReason: string | null = null;

  public serveMeterValue = 0;
  private serveMeterDir = 1;
  private phaseTimer = 0;
  private bannerText: string | null = null;
  private bannerTone: 'info' | 'fault' | 'redo' | 'point' = 'info';
  private winner: TeamId | null = null;

  private botServeDelay = 0;
  private popupCounter = 0;
  public popups: TimingPopup[] = [];
  private feedCounter = 0;
  public feed: FeedEntry[] = [];

  private readonly players: CharacterController[];
  private readonly physics: PhysicsWorld;
  private readonly camera: THREE.Camera;
  private readonly onNetRipple: (x: number, z: number, speed: number) => void;

  constructor(
    players: CharacterController[],
    physics: PhysicsWorld,
    camera: THREE.Camera,
    onNetRipple: (x: number, z: number, speed: number) => void
  ) {
    this.players = players;
    this.physics = physics;
    this.camera = camera;
    this.onNetRipple = onNetRipple;
    this.setupServe();
  }

  public getCurrentServer(): CharacterController {
    return this.players[this.serveRotation[this.rotationCursor]];
  }

  public getServingTeam(): TeamId {
    return this.getCurrentServer().team;
  }

  public resetMatch(pointsToWin?: 15 | 21): void {
    if (pointsToWin) this.pointsToWin = pointsToWin;
    this.scoreA = 0;
    this.scoreB = 0;
    this.rotationCursor = 0;
    this.isVeryFirstServeOfMatch = true;
    this.servePointsRemaining = 1;
    this.serveAttempt = 1;
    this.winner = null;
    this.setupServe();
  }

  public resetRally(): void {
    if (this.phase === 'MATCH_OVER') {
      this.resetMatch();
      return;
    }
    this.serveAttempt = 1;
    this.setupServe();
  }

  private getServerHandPos(server: CharacterController): THREE.Vector3 {
    const toNet = new THREE.Vector3(-server.position.x, 0, -server.position.z);
    if (toNet.lengthSq() > 0.001) toNet.normalize();
    const right = new THREE.Vector3(-toNet.z, 0, toNet.x);
    return server.position
      .clone()
      .addScaledVector(toNet, 0.3)
      .addScaledVector(right, 0.2)
      .add(new THREE.Vector3(0, 1.15, 0));
  }

  private setupServe(): void {
    this.players.forEach((p) => p.resetToStart());
    const server = this.getCurrentServer();

    // Place server centered in their own 90° quarter slice behind the 2.60 m service line
    const angle = server.config.quarterCenterAngle;
    const serveR = IRF_2026_RULES.serviceLineRadius + 0.3;
    server.position.set(Math.sin(angle) * serveR, 0, Math.cos(angle) * serveR);
    server.facingAngle = Math.atan2(-server.position.x, -server.position.z);
    server.root.position.copy(server.position);
    server.root.rotation.y = server.facingAngle;

    this.possessionTeam = server.team;
    this.teamTouches = 0;
    this.lastTouchPlayerIdx = server.config.slotIndex;
    this.lastAttackTeam = null;
    this.isFirstPossessionAfterServe = true;
    this.serveHitNet = false;
    this.serveReboundedOffNet = false;
    this.servePeakAfterNet = 0;
    this.serveFaultPendingReason = null;
    this.serveMeterValue = 0.1;
    this.serveMeterDir = 1;
    this.phase = 'SERVE_WAIT_TOSS';
    this.botServeDelay = 0.9;
    this.bannerText = null;
    this.bannerTone = 'info';
    const humanTeam = this.players.find((p) => p.isHuman)?.team ?? 'A';
    if (server.isHuman) {
      this.pushFeed('Your serve — swipe up to toss', 'info');
    } else if (server.team === humanTeam) {
      this.pushFeed('Partner serving', 'info');
    } else {
      this.pushFeed('Enemy serving', 'info');
    }

    this.physics.setBallState(this.getServerHandPos(server), new THREE.Vector3(0, 0, 0), false);
  }

  public handleHumanSwipe(
    swipe: SwipeEvent,
    camRight = new THREE.Vector3(1, 0, 0)
  ): void {
    const human = this.players.find((p) => p.isHuman);
    if (!human) return;

    if (this.phase === 'SERVE_WAIT_TOSS' && this.getCurrentServer() === human) {
      // Step 1: Swipe Up to toss ball
      if (swipe.dy < -16) {
        const tossVel = ShotResolver.resolveServeToss(human);
        const startPos = this.getServerHandPos(human);
        this.physics.setBallState(startPos, tossVel, true);
        human.setAnimState('serve_toss', 0.45);
        this.phase = 'SERVE_METER_ACTIVE';
        this.serveMeterValue = 0.08;
        this.serveMeterDir = 1;
        this.bannerText = null;
        this.bannerTone = 'info';
        this.pushFeed('Swipe in green to serve!', 'info');
      }
      return;
    }

    if (this.phase === 'SERVE_METER_ACTIVE' && this.getCurrentServer() === human) {
      // Check service line foot fault (server must stay behind 2.60 m)
      if (Math.hypot(human.position.x, human.position.z) < IRF_2026_RULES.serviceLineRadius - 0.03) {
        this.triggerServeFault('Foot Fault (Service Line)');
        return;
      }

      const ballPos = this.physics.getBallPosition();
      const { velocity, quality, isShank } = ShotResolver.resolveServeStrike(
        human,
        ballPos,
        swipe,
        this.serveMeterValue,
        camRight
      );

      this.physics.setBallState(ballPos, velocity, true);
      human.setAnimState('serve_hit', 0.4);
      this.pushFeed(
        isShank ? 'Serve shank!' : `${quality} serve!`,
        isShank ? 'warn' : quality === 'Perfect' ? 'good' : 'info'
      );
      this.phase = 'SERVE_IN_FLIGHT';
      this.bannerText = null;
      return;
    }

    const canReceiveServe =
      this.phase === 'SERVE_IN_FLIGHT' &&
      this.serveReboundedOffNet &&
      human.team !== this.getServingTeam();

    if (this.phase === 'RALLY_LIVE' || canReceiveServe) {
      const ballPos = this.physics.getBallPosition();
      const ballVel = this.physics.getBallVelocity();

      // Only the team with possession can play the ball (unless blocking at net)
      if (this.phase === 'RALLY_LIVE' && this.possessionTeam !== human.team) {
        return;
      }

      // Consecutive touch check (cannot hit twice in a row on same team)
      if (
        this.phase === 'RALLY_LIVE' &&
        this.possessionTeam === human.team &&
        this.lastTouchPlayerIdx === human.config.slotIndex
      ) {
        return;
      }

      const isServeReceive = this.phase === 'SERVE_IN_FLIGHT';
      const nextTouches = isServeReceive ? 1 : this.teamTouches + 1;
      if (nextTouches > 3) return;

      const teammate = this.players.find(
        (p) => p.team === human.team && p.config.slotIndex !== human.config.slotIndex
      );
      const contact = ShotResolver.evaluateContactTiming(ballPos, ballVel, human.position);
      const outcome = ShotResolver.resolveRallyShot(
        human,
        teammate,
        ballPos,
        ballVel,
        swipe,
        nextTouches,
        isServeReceive || this.isFirstPossessionAfterServe,
        camRight,
        contact
      );
      if (!outcome) return;

      if (isServeReceive) {
        this.phase = 'RALLY_LIVE';
        this.possessionTeam = human.team;
        this.isFirstPossessionAfterServe = true;
      }

      // Early return fault on 1st possession after serve (must use all 3 touches!)
      if (
        this.isFirstPossessionAfterServe &&
        outcome.isAttackAtNet &&
        nextTouches < 3
      ) {
        this.awardPoint(human.team === 'A' ? 'B' : 'A', 'Must use 3 touches on serve receive!');
        return;
      }

      if (outcome.triggeredDive) {
        const diveDir = ballPos.clone().sub(human.position).setY(0).normalize();
        human.triggerDive(diveDir);
      } else {
        human.setAnimState(outcome.anim, 0.35);
      }

      if (outcome.isAttackAtNet) {
        human.markNHZFollowThrough();
        this.lastAttackTeam = human.team;
      }

      this.physics.setBallState(ballPos, outcome.velocity, true);
      this.possessionTeam = human.team;
      this.teamTouches = nextTouches;
      this.lastTouchPlayerIdx = human.config.slotIndex;

      const shotName =
        outcome.shotType === 'SPIKE'
          ? 'Spike'
          : outcome.shotType === 'HIGH'
            ? nextTouches <= 2
              ? 'Set'
              : 'Lob'
            : 'Low Hit';
      const tone: FeedEntry['tone'] =
        outcome.timing === 'Bad'
          ? 'bad'
          : outcome.timing === 'Perfect'
            ? 'good'
            : 'warn';
      this.pushFeed(
        outcome.timing === 'Bad' ? `Bad ${shotName} (Shank)` : `${outcome.timing} ${shotName}`,
        tone
      );
    }
  }

  public handleBotTouch(
    bot: CharacterController,
    velocity: THREE.Vector3,
    isAttackAtNet: boolean
  ): void {
    if (this.phase !== 'RALLY_LIVE' && this.phase !== 'SERVE_IN_FLIGHT') return;
    if (this.phase === 'SERVE_IN_FLIGHT') {
      if (!this.serveReboundedOffNet || bot.team === this.getServingTeam()) return;
      this.phase = 'RALLY_LIVE';
      this.possessionTeam = bot.team;
      this.teamTouches = 1;
      this.isFirstPossessionAfterServe = true;
    } else {
      if (this.possessionTeam !== bot.team) return;
      if (this.lastTouchPlayerIdx === bot.config.slotIndex) return;
      if (this.teamTouches >= 3) return;
      this.teamTouches += 1;
    }

    if (isAttackAtNet) {
      this.lastAttackTeam = bot.team;
      bot.markNHZFollowThrough();
    }
    this.lastTouchPlayerIdx = bot.config.slotIndex;
    const ballPos = this.physics.getBallPosition();
    this.physics.setBallState(ballPos, velocity, true);
    bot.setAnimState(isAttackAtNet ? 'spike' : 'hit_high', 0.35);
  }

  public onNetHit(x: number, z: number, speed: number): void {
    this.onNetRipple(x, z, speed);

    if (this.phase === 'SERVE_IN_FLIGHT') {
      if (!this.serveHitNet) {
        this.serveHitNet = true;
        this.serveReboundedOffNet = true;
        this.servePeakAfterNet = OFFICIAL_NET.netHeight + OFFICIAL_BALL.radius;
      } else {
        this.triggerServeFault('Double Bounce on Serve');
      }
      return;
    }

    if (this.phase === 'RALLY_LIVE') {
      // Double bounce on net without being touched
      if (this.teamTouches === 0 && this.lastTouchPlayerIdx === -1) {
        // Ball bounced twice on net -> hitting team loses point
        const defendingTeam = this.possessionTeam;
        this.awardPoint(defendingTeam, 'Double Bounce on Net!');
        return;
      }

      // Enforce 3-touch rule on first possession after serve
      if (this.isFirstPossessionAfterServe && this.teamTouches < 3) {
        this.awardPoint(
          this.possessionTeam === 'A' ? 'B' : 'A',
          'Must use 3 touches on serve receive!'
        );
        return;
      }

      // Ball legally struck net -> possession flips to opposing team
      const hittingTeam = this.lastAttackTeam ?? this.possessionTeam;
      this.possessionTeam = hittingTeam === 'A' ? 'B' : 'A';
      this.teamTouches = 0;
      this.lastTouchPlayerIdx = -1;
      this.lastAttackTeam = hittingTeam;
      this.isFirstPossessionAfterServe = false;
      const humanTeam = this.players.find((p) => p.isHuman)?.team ?? 'A';
      if (this.possessionTeam === humanTeam) {
        this.pushFeed('Your ball — get under it!', 'info');
      }
    }
  }

  public onRimHit(_x: number, _z: number): void {
    if (this.phase === 'SERVE_IN_FLIGHT') {
      if (!this.serveReboundedOffNet) {
        this.triggerServeFault('Serve Rim Fault');
      }
      return;
    }
    if (this.phase === 'RALLY_LIVE') {
      this.pushFeed('Rim Fault!', 'bad');
      // IRF rule: hitting the rim on an attack is a fault for the hitting team
      const hittingTeam = this.teamTouches > 0 ? this.possessionTeam : (this.lastAttackTeam ?? 'A');
      this.awardPoint(hittingTeam === 'A' ? 'B' : 'A', 'Rim Fault!');
    }
  }

  public onGroundHit(x: number, z: number): void {
    const dist = Math.hypot(x, z);

    if (this.phase === 'SERVE_WAIT_TOSS') return;

    if (this.phase === 'SERVE_METER_ACTIVE') {
      this.triggerServeFault('Missed Serve Toss');
      return;
    }

    if (this.phase === 'SERVE_IN_FLIGHT') {
      if (!this.serveReboundedOffNet) {
        this.triggerServeFault('Serve Missed Net');
      } else if (dist <= IRF_2026_RULES.noHitZoneRadius) {
        this.triggerServeFault('Serve Short (NHZ Drop Fault)');
      } else {
        this.awardPoint(this.getServingTeam(), 'SERVICE ACE!');
      }
      return;
    }

    if (this.phase === 'RALLY_LIVE') {
      // Check NHZ "no-drop" rule for net attacks
      if (this.teamTouches === 0 && dist <= IRF_2026_RULES.noHitZoneRadius && this.lastAttackTeam) {
        this.awardPoint(
          this.lastAttackTeam === 'A' ? 'B' : 'A',
          'Attack Died in No-Hit Zone!'
        );
        return;
      }

      // If teamTouches === 0, defending team (possessionTeam) failed to reach the rebound
      const winner = this.possessionTeam === 'A' ? 'B' : 'A';
      this.awardPoint(winner, this.teamTouches === 0 ? 'Clean Point!' : 'Ball Hit Ground!');
    }
  }

  public onObstacleHit(x: number, y: number, z: number): void {
    if (!IRF_2026_RULES.outsideInterferenceRedo) return;
    if (this.phase !== 'RALLY_LIVE' && this.phase !== 'SERVE_IN_FLIGHT') return;

    if (this.phase === 'SERVE_IN_FLIGHT' && !this.serveReboundedOffNet) {
      this.triggerServeFault('Serve Missed Net');
      return;
    }

    this.phase = 'REDO_BANNER';
    this.phaseTimer = 1.8;
    this.bannerText = 'REDO — Outside Interference';
    this.bannerTone = 'redo';
    this.serveAttempt = 1;
    this.spawnPopup(new THREE.Vector3(x, y, z), 'REDO!', 'Redo');
  }

  private triggerServeFault(reason: string): void {
    if (this.phase === 'POINT_OVER' || this.phase === 'REDO_BANNER' || this.phase === 'MATCH_OVER') {
      return;
    }
    if (this.serveAttempt === 1) {
      this.serveAttempt = 2;
      this.phase = 'POINT_OVER';
      this.phaseTimer = 1.2;
      this.bannerText = null;
      this.bannerTone = 'fault';
      this.pushFeed(`${reason} — 2nd Serve`, 'warn');
    } else {
      const receiverTeam: TeamId = this.getServingTeam() === 'A' ? 'B' : 'A';
      this.awardPoint(receiverTeam, `Double Fault (${reason})`);
    }
  }

  private awardPoint(winnerTeam: TeamId, reason: string): void {
    if (this.phase === 'POINT_OVER' || this.phase === 'MATCH_OVER') return;
    if (winnerTeam === 'A') this.scoreA += 1;
    else this.scoreB += 1;

    const humanTeam = this.players.find((p) => p.isHuman)?.team ?? 'A';
    const wonPoint = winnerTeam === humanTeam;
    this.pushFeed(
      `${wonPoint ? 'Your Point!' : 'Enemy Point!'} · ${reason}`,
      wonPoint ? 'good' : 'bad'
    );

    const high = Math.max(this.scoreA, this.scoreB);
    const diff = Math.abs(this.scoreA - this.scoreB);
    if (high >= this.pointsToWin && (!IRF_2026_RULES.winByTwo || diff >= 2)) {
      this.winner = winnerTeam;
      this.phase = 'MATCH_OVER';
      this.bannerText = `${wonPoint ? 'YOU WIN' : 'ENEMY WINS'} ${this.scoreA}–${this.scoreB}!`;
      this.bannerTone = 'point';
      return;
    }

    // IRF Equal Serving rotation
    this.servePointsRemaining -= 1;
    if (this.servePointsRemaining <= 0) {
      this.rotationCursor = (this.rotationCursor + 1) % this.serveRotation.length;
      this.isVeryFirstServeOfMatch = false;
      const inOvertime =
        this.scoreA >= this.pointsToWin - 1 && this.scoreB >= this.pointsToWin - 1;
      this.servePointsRemaining = inOvertime ? 1 : 2;
    }

    this.serveAttempt = 1;
    this.phase = 'POINT_OVER';
    this.phaseTimer = 1.5;
    this.bannerText = null;
    this.bannerTone = 'point';
  }

  public update(dt: number): void {
    const ballPos = this.physics.getBallPosition();
    const ballVel = this.physics.getBallVelocity();

    const now = performance.now();
    this.popups = this.popups.filter((p) => now - p.createdAt < 900);
    this.feed = this.feed.filter((f) => now - f.createdAt < 3400);

    // Physical character-to-character collisions + IRF Interference (Hinder) call
    this.resolvePlayerCollisions(ballPos);

    // Block collider check for human & bots at net
    if (this.phase === 'RALLY_LIVE') {
      for (const p of this.players) {
        if (!p.isBlocking) continue;
        const d = Math.hypot(ballPos.x - p.position.x, ballPos.z - p.position.z);
        if (d < 0.85 && ballPos.y >= 0.8 && ballPos.y <= 2.15 && this.possessionTeam !== p.team) {
          this.possessionTeam = p.team;
          this.teamTouches = 1;
          this.lastTouchPlayerIdx = p.config.slotIndex;
          this.isFirstPossessionAfterServe = false;
          this.physics.setBallState(
            ballPos,
            new THREE.Vector3(-ballVel.x * 0.25, 5.1, -ballVel.z * 0.25),
            true
          );
          this.pushFeed('Block!', 'good');
        }
      }
    }

    // Serve-in-flight checks: rebound into server/partner or high bounce fault
    if (this.phase === 'SERVE_IN_FLIGHT' && this.serveReboundedOffNet) {
      this.servePeakAfterNet = Math.max(this.servePeakAfterNet, ballPos.y);
      if (this.servePeakAfterNet > IRF_2026_RULES.maxServeBounceHeight && !this.serveFaultPendingReason) {
        this.serveFaultPendingReason = 'High Serve Bounce (> Shoulder)';
        this.triggerServeFault(this.serveFaultPendingReason);
        return;
      }

      const servingTeam = this.getServingTeam();
      for (const p of this.players) {
        if (p.team !== servingTeam) continue;
        const d = Math.hypot(ballPos.x - p.position.x, ballPos.z - p.position.z);
        if (d < 0.45 && ballPos.y < 1.85) {
          this.awardPoint(servingTeam === 'A' ? 'B' : 'A', 'Serve Hit Serving Team!');
          return;
        }
      }
    }

    // Golf-style timing meter oscillation (smooth, readable pace)
    if (this.phase === 'SERVE_METER_ACTIVE') {
      this.serveMeterValue += this.serveMeterDir * dt * 1.05;
      if (this.serveMeterValue >= 1) {
        this.serveMeterValue = 1;
        this.serveMeterDir = -1;
      } else if (this.serveMeterValue <= 0) {
        this.serveMeterValue = 0;
        this.serveMeterDir = 1;
      }

      if (ballPos.y <= 0.14 && ballVel.y < 0) {
        this.triggerServeFault('Missed Serve Toss');
      }
    }

    // Keep ball pinned in server's hand while waiting for toss
    const server = this.getCurrentServer();
    if (this.phase === 'SERVE_WAIT_TOSS') {
      this.physics.setBallState(this.getServerHandPos(server), new THREE.Vector3(0, 0, 0), false);
    }

    // Bot server auto-serve: calibrated fast, legal serve across the net
    if (this.phase === 'SERVE_WAIT_TOSS' && !server.isHuman) {
      this.botServeDelay -= dt;
      if (this.botServeDelay <= 0) {
        const startPos = this.getServerHandPos(server);
        const netPlaneY = OFFICIAL_NET.netHeight + OFFICIAL_BALL.radius;
        const target = new THREE.Vector3(
          (Math.random() - 0.5) * 0.14,
          netPlaneY,
          (Math.random() - 0.5) * 0.14
        );
        const flightTime = 0.34 + Math.random() * 0.05;
        const vel = computeBallisticVelocity(startPos, target, flightTime);
        this.physics.setBallState(startPos, vel, true);
        server.setAnimState('serve_hit', 0.4);
        this.phase = 'SERVE_IN_FLIGHT';
        this.bannerText = null;
      }
    }

    // Phase timers for POINT_OVER and REDO_BANNER
    if (this.phase === 'POINT_OVER' || this.phase === 'REDO_BANNER') {
      this.phaseTimer -= dt;
      if (this.phaseTimer <= 0) {
        this.setupServe();
      }
    }
  }

  private resolvePlayerCollisions(ballPos: THREE.Vector3): void {
    const minSep = MOVEMENT_TUNING.playerRadius * 2.05; // ~0.70 m physical body separation
    const isLivePlay =
      this.phase === 'RALLY_LIVE' ||
      (this.phase === 'SERVE_IN_FLIGHT' && this.serveReboundedOffNet);
    const activeTeam: TeamId =
      this.phase === 'SERVE_IN_FLIGHT'
        ? this.getServingTeam() === 'A'
          ? 'B'
          : 'A'
        : this.possessionTeam;

    for (let i = 0; i < this.players.length; i++) {
      for (let j = i + 1; j < this.players.length; j++) {
        const a = this.players[i];
        const b = this.players[j];
        const dx = b.position.x - a.position.x;
        const dz = b.position.z - a.position.z;
        const dist = Math.hypot(dx, dz);

        if (dist < minSep) {
          const nx = dist > 0.001 ? dx / dist : 1;
          const nz = dist > 0.001 ? dz / dist : 0;
          const overlap = (minSep - dist) * 0.5;

          a.position.x -= nx * overlap;
          a.position.z -= nz * overlap;
          b.position.x += nx * overlap;
          b.position.z += nz * overlap;
          a.root.position.copy(a.position);
          b.root.position.copy(b.position);

          // IRF Hinder / Interference Call:
          // Opposing defender physically obstructs a possessing player actively playing/chasing the live ball
          if (isLivePlay && a.team !== b.team) {
            const possessor = a.team === activeTeam ? a : b;
            const defender = a.team === activeTeam ? b : a;
            const distToBall = Math.hypot(
              ballPos.x - possessor.position.x,
              ballPos.z - possessor.position.z
            );
            const possessorSpeed = Math.hypot(possessor.velocity.x, possessor.velocity.z);
            if (!defender.isBlocking && (distToBall < 3.4 || possessorSpeed > 1.8)) {
              const mid = a.position.clone().lerp(b.position, 0.5);
              this.triggerPlayerInterference(mid);
              return;
            }
          }
        }
      }
    }
  }

  private triggerPlayerInterference(worldPos: THREE.Vector3): void {
    if (this.phase === 'REDO_BANNER' || this.phase === 'POINT_OVER' || this.phase === 'MATCH_OVER') {
      return;
    }
    this.phase = 'REDO_BANNER';
    this.phaseTimer = 1.8;
    this.bannerText = 'INTERFERENCE — REDO';
    this.bannerTone = 'redo';
    this.serveAttempt = 1;
    this.spawnPopup(worldPos.clone().add(new THREE.Vector3(0, 1.3, 0)), 'INTERFERENCE!', 'Redo');
  }

  public pushFeed(text: string, tone: FeedEntry['tone'] = 'info'): void {
    const now = performance.now();
    const last = this.feed[0];
    if (last && last.text === text && now - last.createdAt < 1200) {
      return;
    }
    this.feed.unshift({
      id: ++this.feedCounter,
      text,
      tone,
      createdAt: now,
    });
    if (this.feed.length > 3) {
      this.feed.length = 3;
    }
  }

  public showPopup(
    worldPos: THREE.Vector3,
    text: string,
    quality: TimingPopup['quality']
  ): void {
    this.spawnPopup(worldPos, text, quality);
  }

  private spawnPopup(
    worldPos: THREE.Vector3,
    text: string,
    quality: TimingPopup['quality']
  ): void {
    const winW = typeof window !== 'undefined' ? window.innerWidth : 1024;
    const winH = typeof window !== 'undefined' ? window.innerHeight : 768;
    const proj = worldPos.clone().add(new THREE.Vector3(0, 0.35, 0)).project(this.camera);
    const screenX = (proj.x * 0.5 + 0.5) * winW;
    const screenY = (-proj.y * 0.5 + 0.5) * winH;
    this.popups.push({
      id: ++this.popupCounter,
      text,
      quality,
      screenX,
      screenY,
      createdAt: performance.now(),
    });
  }

  public getHUDState(): MatchHUDState {
    const server = this.getCurrentServer();
    const human = this.players.find((p) => p.isHuman);
    const effectivePossession: TeamId =
      this.phase === 'SERVE_IN_FLIGHT' && this.serveReboundedOffNet
        ? server.team === 'A'
          ? 'B'
          : 'A'
        : this.possessionTeam;
    return {
      scoreA: this.scoreA,
      scoreB: this.scoreB,
      humanTeam: human?.team ?? 'A',
      pointsToWin: this.pointsToWin,
      servingTeam: server.team,
      serverIndex: server.config.slotIndex,
      serverName: server.config.profile.name,
      isHumanServing: server.isHuman,
      serveAttempt: this.serveAttempt,
      servePointsRemaining: this.isVeryFirstServeOfMatch ? 1 : this.servePointsRemaining,
      possessionTeam: effectivePossession,
      teamTouches: this.teamTouches,
      isFirstPossessionAfterServe: this.isFirstPossessionAfterServe,
      phase: this.phase,
      serveMeterValue: this.serveMeterValue,
      serveMeterActive: this.phase === 'SERVE_METER_ACTIVE',
      bannerText: this.bannerText,
      bannerTone: this.bannerTone,
      humanStamina: human ? human.stamina : 100,
      humanMaxStamina: human ? 100 * human.config.profile.stats.stamina : 100,
      humanExhausted: human ? human.isExhausted : false,
      winner: this.winner,
    };
  }
}
