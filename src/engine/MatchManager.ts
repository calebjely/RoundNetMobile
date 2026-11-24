import * as THREE from 'three';
import { TeamId } from '../config/characters';
import { OFFICIAL_BALL, OFFICIAL_NET } from '../config/equipment';
import { IRF_2026_RULES } from '../config/rules';
import { CharacterController } from './CharacterController';
import { PhysicsWorld } from './PhysicsWorld';
import { ShotResolver, TimingQuality } from './ShotResolver';
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

export interface MatchHUDState {
  scoreA: number;
  scoreB: number;
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

  // Equal Serving Rotation:
  // Order of servers: [0 (Team A), 2 (Team B), 1 (Team A), 3 (Team B)]
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
  private serveHitNet = false;
  private serveReboundedOffNet = false;
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

  private setupServe(): void {
    this.players.forEach((p) => p.resetToStart());
    const server = this.getCurrentServer();

    // Ensure server starts behind 2.60 m service line
    const sideSign = server.team === 'A' ? 1 : -1;
    server.position.set(0, 0, sideSign * (IRF_2026_RULES.serviceLineRadius + 0.25));
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
    this.botServeDelay = 1.05;
    this.bannerText = `${server.config.profile.name} to Serve (${this.serveAttempt === 1 ? '1st' : '2nd'} Attempt)`;
    this.bannerTone = 'info';

    // Hold ball in server's hand
    const handPos = server.position.clone().add(new THREE.Vector3(0.22, 1.15, -sideSign * 0.25));
    this.physics.setBallState(handPos, new THREE.Vector3(0, 0, 0), false);
  }

  public handleHumanSwipe(swipe: SwipeEvent): void {
    const human = this.players.find((p) => p.isHuman);
    if (!human) return;

    if (this.phase === 'SERVE_WAIT_TOSS' && this.getCurrentServer() === human) {
      // Step 1: Swipe Up to toss ball
      if (swipe.dy < -18) {
        const tossVel = ShotResolver.resolveServeToss(human);
        const startPos = human.position.clone().add(new THREE.Vector3(0.15, 1.25, -0.25));
        this.physics.setBallState(startPos, tossVel, true);
        human.setAnimState('serve_toss', 0.45);
        this.phase = 'SERVE_METER_ACTIVE';
        this.serveMeterValue = 0.05;
        this.serveMeterDir = 1;
        this.bannerText = 'SWIPE IN SWEET SPOT!';
        this.bannerTone = 'info';
      }
      return;
    }

    if (this.phase === 'SERVE_METER_ACTIVE' && this.getCurrentServer() === human) {
      // Step 2: Strike serve using golf timing meter
      const ballPos = this.physics.getBallPosition();
      const { velocity, quality, isShank } = ShotResolver.resolveServeStrike(
        human,
        ballPos,
        swipe,
        this.serveMeterValue
      );

      // Check service line foot fault (server must stay behind 2.60 m)
      if (Math.hypot(human.position.x, human.position.z) < IRF_2026_RULES.serviceLineRadius) {
        this.triggerServeFault('Foot Fault (Service Line)');
        return;
      }

      this.physics.setBallState(ballPos, velocity, true);
      human.setAnimState('serve_hit', 0.4);
      this.spawnPopup(ballPos, isShank ? 'SHANK!' : quality, isShank ? 'Fault' : quality);
      this.phase = 'SERVE_IN_FLIGHT';
      this.bannerText = null;
      return;
    }

    if (
      this.phase === 'RALLY_LIVE' ||
      (this.phase === 'SERVE_IN_FLIGHT' && this.serveReboundedOffNet && human.team !== this.getServingTeam())
    ) {
      const ballPos = this.physics.getBallPosition();
      const ballVel = this.physics.getBallVelocity();

      // Consecutive touch check (cannot hit twice in a row on same team unless Touch 1 block)
      if (
        this.phase === 'RALLY_LIVE' &&
        this.possessionTeam === human.team &&
        this.lastTouchPlayerIdx === human.config.slotIndex
      ) {
        return;
      }

      const isServeReceive = this.phase === 'SERVE_IN_FLIGHT';
      const nextTouches = isServeReceive ? 1 : this.possessionTeam === human.team ? this.teamTouches + 1 : 1;
      if (nextTouches > 3) return;

      const teammate = this.players.find(
        (p) => p.team === human.team && p.config.slotIndex !== human.config.slotIndex
      );
      const outcome = ShotResolver.resolveRallyShot(
        human,
        teammate,
        ballPos,
        ballVel,
        swipe,
        nextTouches
      );
      if (!outcome) return;

      if (isServeReceive) {
        this.phase = 'RALLY_LIVE';
        this.isFirstPossessionAfterServe = true;
      }

      // Early return fault on 1st possession after serve
      if (
        this.isFirstPossessionAfterServe &&
        this.possessionTeam === human.team &&
        outcome.isAttackAtNet &&
        nextTouches < 3
      ) {
        this.awardPoint(human.team === 'A' ? 'B' : 'A', 'Must use 3 touches on serve receive!');
        return;
      }

      // NHZ check on final hitter strike
      if (outcome.isAttackAtNet && human.isInsideNHZ()) {
        this.awardPoint(human.team === 'A' ? 'B' : 'A', 'No-Hit Zone Foot Fault!');
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
      this.spawnPopup(ballPos, outcome.timing, outcome.timing);
    }
  }

  public handleBotTouch(
    bot: CharacterController,
    velocity: THREE.Vector3,
    isAttackAtNet: boolean
  ): void {
    if (this.phase !== 'RALLY_LIVE' && this.phase !== 'SERVE_IN_FLIGHT') return;
    if (this.phase === 'SERVE_IN_FLIGHT') {
      if (!this.serveReboundedOffNet) return;
      this.phase = 'RALLY_LIVE';
      this.possessionTeam = bot.team;
      this.teamTouches = 1;
      this.isFirstPossessionAfterServe = true;
    } else if (this.possessionTeam !== bot.team) {
      this.possessionTeam = bot.team;
      this.teamTouches = 1;
      this.isFirstPossessionAfterServe = false;
    } else {
      if (this.lastTouchPlayerIdx === bot.config.slotIndex) return;
      this.teamTouches = Math.min(3, this.teamTouches + 1);
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
        this.servePeakAfterNet = OFFICIAL_NET.netHeight;
      } else {
        // Double bounce on net during serve
        this.triggerServeFault('Double Bounce on Serve');
      }
      return;
    }

    if (this.phase === 'RALLY_LIVE') {
      // Check follow-through NHZ fault for last attacker
      const lastHitter = this.players.find((p) => p.config.slotIndex === this.lastTouchPlayerIdx);
      if (lastHitter && lastHitter.hasActiveNHZFollowThrough() && lastHitter.isInsideNHZ()) {
        this.awardPoint(lastHitter.team === 'A' ? 'B' : 'A', 'No-Hit Zone Follow-Through Fault!');
        return;
      }

      // Ball hit net -> possession flips to opposing team
      const hittingTeam = this.lastAttackTeam ?? this.possessionTeam;
      this.possessionTeam = hittingTeam === 'A' ? 'B' : 'A';
      this.teamTouches = 0;
      this.lastTouchPlayerIdx = -1;
      this.lastAttackTeam = null;
      this.isFirstPossessionAfterServe = false;
    }
  }

  public onRimHit(x: number, z: number): void {
    if (this.phase === 'SERVE_IN_FLIGHT') {
      if (!this.serveReboundedOffNet) {
        this.triggerServeFault('Serve Rim Fault');
      }
      return;
    }
    if (this.phase === 'RALLY_LIVE') {
      this.spawnPopup(new THREE.Vector3(x, OFFICIAL_NET.netHeight + 0.1, z), 'RIM!', 'Info');
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
        // IRF "No-Drop" rule: serve landing inside 1.00 m NHZ is a fault
        this.triggerServeFault('Serve Short (NHZ Drop Fault)');
      } else {
        // Clean Ace!
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

      // If teamTouches === 0, ball just rebounded off net and receiving team failed to reach it
      if (this.teamTouches === 0) {
        const winner = this.possessionTeam === 'A' ? 'B' : 'A';
        this.awardPoint(winner, 'Clean Point!');
      } else {
        // Ball dropped while possessionTeam was trying to pass/set
        const winner = this.possessionTeam === 'A' ? 'B' : 'A';
        this.awardPoint(winner, 'Ball Hit Ground!');
      }
    }
  }

  public onObstacleHit(x: number, y: number, z: number): void {
    if (!IRF_2026_RULES.outsideInterferenceRedo) return;
    if (this.phase !== 'RALLY_LIVE' && this.phase !== 'SERVE_IN_FLIGHT') return;

    // If serve faulted BEFORE reaching the net/obstacle, fault resolves first
    if (this.phase === 'SERVE_IN_FLIGHT' && !this.serveReboundedOffNet) {
      this.triggerServeFault('Serve Missed Net');
      return;
    }

    // Outside Interference -> REDO!
    this.phase = 'REDO_BANNER';
    this.phaseTimer = 1.9;
    this.bannerText = 'REDO — Outside Interference';
    this.bannerTone = 'redo';
    this.serveAttempt = 1; // Reset current server to 1st serve
    this.spawnPopup(new THREE.Vector3(x, y, z), 'REDO!', 'Redo');
  }

  private triggerServeFault(reason: string): void {
    if (this.phase === 'POINT_OVER' || this.phase === 'REDO_BANNER') return;
    if (this.serveAttempt === 1) {
      this.serveAttempt = 2;
      this.phase = 'POINT_OVER';
      this.phaseTimer = 1.25;
      this.bannerText = `FAULT: ${reason} — 2nd Serve`;
      this.bannerTone = 'fault';
    } else {
      const receiverTeam: TeamId = this.getServingTeam() === 'A' ? 'B' : 'A';
      this.awardPoint(receiverTeam, `Double Fault (${reason})`);
    }
  }

  private awardPoint(winnerTeam: TeamId, reason: string): void {
    if (this.phase === 'POINT_OVER' || this.phase === 'MATCH_OVER') return;
    if (winnerTeam === 'A') this.scoreA += 1;
    else this.scoreB += 1;

    // Check Win Condition (15 or 21, win by 2)
    const high = Math.max(this.scoreA, this.scoreB);
    const diff = Math.abs(this.scoreA - this.scoreB);
    if (high >= this.pointsToWin && (!IRF_2026_RULES.winByTwo || diff >= 2)) {
      this.winner = winnerTeam;
      this.phase = 'MATCH_OVER';
      this.bannerText = `${winnerTeam === 'A' ? 'TEAM BLUE' : 'TEAM ORANGE'} WINS ${this.scoreA}–${this.scoreB}!`;
      this.bannerTone = 'point';
      return;
    }

    // Advance IRF Equal Serving rotation
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
    this.phaseTimer = 1.6;
    this.bannerText = `${winnerTeam === 'A' ? 'Blue' : 'Orange'} Point! (${reason})`;
    this.bannerTone = 'point';
  }

  public update(dt: number): void {
    const ballPos = this.physics.getBallPosition();
    const ballVel = this.physics.getBallVelocity();

    // Prune popups older than 0.9s
    const now = performance.now();
    this.popups = this.popups.filter((p) => now - p.createdAt < 900);

    // Block collider check for human & bots
    if (this.phase === 'RALLY_LIVE') {
      for (const p of this.players) {
        if (!p.isBlocking) continue;
        const d = Math.hypot(ballPos.x - p.position.x, ballPos.z - p.position.z);
        if (d < 0.78 && ballPos.y >= 0.85 && ballPos.y <= 2.15 && this.possessionTeam !== p.team) {
          // Clean upward block pop!
          this.possessionTeam = p.team;
          this.teamTouches = 1;
          this.lastTouchPlayerIdx = p.config.slotIndex;
          this.isFirstPossessionAfterServe = false;
          this.physics.setBallState(
            ballPos,
            new THREE.Vector3(-ballVel.x * 0.25, 4.6, -ballVel.z * 0.25),
            true
          );
          this.spawnPopup(ballPos, 'BLOCK!', 'Perfect');
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

      // Rebounding off net into server or server's partner = immediate loss of point
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

    // Golf-style timing meter oscillation
    if (this.phase === 'SERVE_METER_ACTIVE') {
      this.serveMeterValue += this.serveMeterDir * dt * 1.65;
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
      const sideSign = server.team === 'A' ? 1 : -1;
      const handPos = server.position.clone().add(new THREE.Vector3(0.22, 1.15, -sideSign * 0.25));
      this.physics.setBallState(handPos, new THREE.Vector3(0, 0, 0), false);
    }

    // Bot server auto-serve
    if (this.phase === 'SERVE_WAIT_TOSS' && !server.isHuman) {
      this.botServeDelay -= dt;
      if (this.botServeDelay <= 0) {
        const startPos = server.position.clone().add(new THREE.Vector3(0.15, 1.25, 0));
        const target = new THREE.Vector3((Math.random() - 0.5) * 0.16, OFFICIAL_NET.netHeight, 0);
        const vel = ShotResolver.resolveServeStrike(
          server,
          startPos,
          { dx: 0, dy: -60, distancePx: 60, speedPxPerSec: 800, startX: 0, startY: 0 },
          0.5 + (Math.random() - 0.5) * 0.12
        ).velocity;
        // Recompute cleanly from startPos -> target
        const dist = startPos.length();
        const flight = Math.max(0.24, dist * 0.095);
        const g = OFFICIAL_BALL.gravity;
        vel.set(
          (target.x - startPos.x) / flight,
          (target.y - startPos.y - 0.5 * g * flight * flight) / flight,
          (target.z - startPos.z) / flight
        );
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

  private spawnPopup(
    worldPos: THREE.Vector3,
    text: string,
    quality: TimingPopup['quality']
  ): void {
    const proj = worldPos.clone().add(new THREE.Vector3(0, 0.35, 0)).project(this.camera);
    const screenX = (proj.x * 0.5 + 0.5) * window.innerWidth;
    const screenY = (-proj.y * 0.5 + 0.5) * window.innerHeight;
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
    return {
      scoreA: this.scoreA,
      scoreB: this.scoreB,
      pointsToWin: this.pointsToWin,
      servingTeam: server.team,
      serverIndex: server.config.slotIndex,
      serverName: server.config.profile.name,
      isHumanServing: server.isHuman,
      serveAttempt: this.serveAttempt,
      servePointsRemaining: this.isVeryFirstServeOfMatch ? 1 : this.servePointsRemaining,
      possessionTeam: this.possessionTeam,
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
