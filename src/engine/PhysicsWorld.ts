import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { OFFICIAL_BALL, OFFICIAL_NET } from '../config/equipment';

export type ColliderSurfaceTag = 'ground' | 'net' | 'rim' | 'obstacle' | 'env';

export interface PhysicsCallbacks {
  onNetHit?: (x: number, z: number, speed: number) => void;
  onRimHit?: (x: number, z: number, speed: number) => void;
  onGroundHit?: (x: number, z: number, speed: number) => void;
  onObstacleHit?: (x: number, y: number, z: number) => void;
}

export class PhysicsWorld {
  public world!: RAPIER.World;
  public ballBody!: RAPIER.RigidBody;
  public ballCollider!: RAPIER.Collider;

  private readonly colliderTags = new Map<number, ColliderSurfaceTag>();
  private readonly envColliders: RAPIER.Collider[] = [];
  private callbacks: PhysicsCallbacks = {};

  private netHitCooldown = 0;
  private rimHitCooldown = 0;
  private groundHitCooldown = 0;
  private obstacleHitCooldown = 0;

  private prevBallPos = new THREE.Vector3();
  private prevBallVel = new THREE.Vector3();
  private ballFrozen = false;

  public async init(callbacks: PhysicsCallbacks = {}): Promise<void> {
    this.callbacks = callbacks;
    await RAPIER.init();

    this.world = new RAPIER.World({ x: 0.0, y: OFFICIAL_BALL.gravity, z: 0.0 });
    this.createGroundPlane();
    this.createOfficialSetColliders();
    this.createBall();
  }

  private createGroundPlane(): void {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const colDesc = RAPIER.ColliderDesc.cuboid(30, 0.25, 30)
      .setTranslation(0, -0.25, 0)
      .setRestitution(OFFICIAL_BALL.groundRestitution)
      .setFriction(0.6);
    const col = this.world.createCollider(colDesc, body);
    this.colliderTags.set(col.handle, 'ground');
  }

  private createOfficialSetColliders(): void {
    const { rimRadius, rimTubeRadius, netHeight, legCount } = OFFICIAL_NET;
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());

    // Trampoline netting disc is handled via continuous plane-crossing detection
    // so Rapier never kills incoming downward velocity before elastic rebound!
    const netDiscRadius = rimRadius - rimTubeRadius * 1.1;
    const netColDesc = RAPIER.ColliderDesc.cylinder(0.01, netDiscRadius)
      .setTranslation(0, netHeight, 0)
      .setSensor(true);
    const netCol = this.world.createCollider(netColDesc, body);
    this.colliderTags.set(netCol.handle, 'net');

    // Tubular Rim segments (16 segments around circumference)
    const segments = 16;
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      const midA = (a0 + a1) * 0.5;
      const segLen = (2 * Math.PI * rimRadius) / segments;
      const cx = Math.cos(midA) * rimRadius;
      const cz = Math.sin(midA) * rimRadius;

      const q = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        -midA + Math.PI / 2
      );
      const rimColDesc = RAPIER.ColliderDesc.cuboid(
        segLen * 0.5,
        rimTubeRadius * 0.85,
        rimTubeRadius * 0.85
      )
        .setTranslation(cx, netHeight, cz)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setRestitution(OFFICIAL_NET.rimRestitution)
        .setFriction(0.3);
      const rimCol = this.world.createCollider(rimColDesc, body);
      this.colliderTags.set(rimCol.handle, 'rim');
    }

    // 5 Radial Legs (rim-tagged so hitting side of set deflects unpredictably)
    for (let i = 0; i < legCount; i++) {
      const angle = (i / legCount) * Math.PI * 2;
      const legColDesc = RAPIER.ColliderDesc.cylinder(netHeight * 0.5, 0.02)
        .setTranslation(Math.cos(angle) * rimRadius, netHeight * 0.5, Math.sin(angle) * rimRadius)
        .setRestitution(OFFICIAL_NET.rimRestitution);
      const legCol = this.world.createCollider(legColDesc, body);
      this.colliderTags.set(legCol.handle, 'rim');
    }
  }

  private createBall(): void {
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, 1.2, 2.8)
      .setLinearDamping(OFFICIAL_BALL.linearDamping)
      .setAngularDamping(0.35)
      .setCcdEnabled(true);
    this.ballBody = this.world.createRigidBody(bodyDesc);

    const colDesc = RAPIER.ColliderDesc.ball(OFFICIAL_BALL.radius)
      .setMass(OFFICIAL_BALL.massKg)
      .setRestitution(0.65)
      .setFriction(0.35)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    this.ballCollider = this.world.createCollider(colDesc, this.ballBody);
  }

  public registerEnvironmentColliders(root: THREE.Object3D): void {
    for (const c of this.envColliders) {
      this.colliderTags.delete(c.handle);
      this.world.removeCollider(c, true);
    }
    this.envColliders.length = 0;

    root.updateMatrixWorld(true);
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const tempVec = new THREE.Vector3();

    root.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh) || !obj.geometry) return;
      if (obj.name === 'ground_lawn') return;

      const geo = obj.geometry as THREE.BufferGeometry;
      const posAttr = geo.getAttribute('position');
      if (!posAttr) return;

      const vertices = new Float32Array(posAttr.count * 3);
      for (let i = 0; i < posAttr.count; i++) {
        tempVec.fromBufferAttribute(posAttr, i).applyMatrix4(obj.matrixWorld);
        vertices[i * 3] = tempVec.x;
        vertices[i * 3 + 1] = tempVec.y;
        vertices[i * 3 + 2] = tempVec.z;
      }

      let indices: Uint32Array;
      if (geo.index) {
        indices = new Uint32Array(geo.index.array);
      } else {
        indices = new Uint32Array(posAttr.count);
        for (let i = 0; i < posAttr.count; i++) indices[i] = i;
      }

      if (vertices.length < 9 || indices.length < 3) return;

      const trimeshDesc = RAPIER.ColliderDesc.trimesh(vertices, indices).setRestitution(0.45);
      const col = this.world.createCollider(trimeshDesc, body);
      const isObstacle = obj.name.toLowerCase().startsWith('obstacle_');
      this.colliderTags.set(col.handle, isObstacle ? 'obstacle' : 'env');
      this.envColliders.push(col);
    });
  }

  public setBallState(pos: THREE.Vector3, vel: THREE.Vector3, wake = true): void {
    this.ballFrozen = !wake;
    this.ballBody.setGravityScale(wake ? 1.0 : 0.0, wake);
    this.ballBody.setTranslation({ x: pos.x, y: pos.y, z: pos.z }, wake);
    this.ballBody.setLinvel({ x: vel.x, y: vel.y, z: vel.z }, wake);
    this.ballBody.setAngvel({ x: 0, y: 0, z: 0 }, wake);
    this.prevBallPos.copy(pos);
    this.prevBallVel.copy(vel);
  }

  public getBallPosition(out = new THREE.Vector3()): THREE.Vector3 {
    const t = this.ballBody.translation();
    return out.set(t.x, t.y, t.z);
  }

  public getBallVelocity(out = new THREE.Vector3()): THREE.Vector3 {
    const v = this.ballBody.linvel();
    return out.set(v.x, v.y, v.z);
  }

  public step(dt: number): void {
    this.netHitCooldown = Math.max(0, this.netHitCooldown - dt);
    this.rimHitCooldown = Math.max(0, this.rimHitCooldown - dt);
    this.groundHitCooldown = Math.max(0, this.groundHitCooldown - dt);
    this.obstacleHitCooldown = Math.max(0, this.obstacleHitCooldown - dt);

    if (this.ballFrozen) return;

    const p0 = this.ballBody.translation();
    const v0 = this.ballBody.linvel();
    this.prevBallPos.set(p0.x, p0.y, p0.z);
    this.prevBallVel.set(v0.x, v0.y, v0.z);

    // Light realistic aerodynamic drag
    const speed = Math.hypot(v0.x, v0.y, v0.z);
    if (speed > 0.05) {
      const dragFactor = 1 - Math.min(0.18, OFFICIAL_BALL.airDrag * speed * dt);
      this.ballBody.setLinvel(
        { x: v0.x * dragFactor, y: v0.y * dragFactor, z: v0.z * dragFactor },
        true
      );
    }

    this.world.timestep = Math.min(dt, 1 / 60);
    this.world.step();

    // 1. Continuous net trampoline plane crossing (prevents Rapier restitution killing vy!)
    if (this.checkNetTrampolineCrossing()) {
      return;
    }

    // 2. Rigid contacts (rim, ground, obstacles)
    this.processContacts();
  }

  private checkNetTrampolineCrossing(): boolean {
    if (this.netHitCooldown > 0) return false;

    const curPos = this.ballBody.translation();
    const netPlaneY = OFFICIAL_NET.netHeight + OFFICIAL_BALL.radius;
    const netDiscRadius = OFFICIAL_NET.rimRadius - OFFICIAL_NET.rimTubeRadius * 0.7;

    // Ball crossed downward through the net surface plane
    if (this.prevBallPos.y >= netPlaneY - 0.04 && curPos.y <= netPlaneY && this.prevBallVel.y < -0.15) {
      const dy = curPos.y - this.prevBallPos.y;
      const alpha = Math.abs(dy) > 0.0001 ? THREE.MathUtils.clamp((netPlaneY - this.prevBallPos.y) / dy, 0, 1) : 0.5;
      const hitX = THREE.MathUtils.lerp(this.prevBallPos.x, curPos.x, alpha);
      const hitZ = THREE.MathUtils.lerp(this.prevBallPos.z, curPos.z, alpha);
      const hitR = Math.hypot(hitX, hitZ);

      if (hitR <= netDiscRadius) {
        this.netHitCooldown = 0.14;
        const incomingSpeed = this.prevBallVel.length();
        const incomingDownVy = Math.abs(this.prevBallVel.y);

        // True elastic trampoline rebound:
        // Steep downward spikes pop HIGH; flatter serves rebound cleanly at receiver height;
        // horizontal speed slows slightly off the elastic mesh so receivers can play it!
        const outVy = Math.max(2.6, incomingDownVy * OFFICIAL_NET.netRestitution);
        const outVx = this.prevBallVel.x * OFFICIAL_NET.netHorizontalDamping;
        const outVz = this.prevBallVel.z * OFFICIAL_NET.netHorizontalDamping;

        this.ballBody.setTranslation({ x: hitX, y: netPlaneY + 0.015, z: hitZ }, true);
        this.ballBody.setLinvel({ x: outVx, y: outVy, z: outVz }, true);
        this.callbacks.onNetHit?.(hitX, hitZ, incomingSpeed);
        return true;
      }
    }

    return false;
  }

  private processContacts(): void {
    const ballPos = this.ballBody.translation();
    const ballVel = this.ballBody.linvel();
    const speed = Math.hypot(ballVel.x, ballVel.y, ballVel.z);

    this.world.contactPairsWith(this.ballCollider, (other) => {
      const tag = this.colliderTags.get(other.handle);
      if (!tag || tag === 'net') return;

      if (tag === 'rim' && this.rimHitCooldown <= 0) {
        this.rimHitCooldown = 0.14;
        const chaos = OFFICIAL_NET.rimChaosFactor;
        const inSpeed = Math.max(speed, this.prevBallVel.length());
        this.ballBody.setLinvel(
          {
            x: ballVel.x + (Math.random() - 0.5) * inSpeed * chaos,
            y: Math.max(1.8, Math.abs(this.prevBallVel.y) * OFFICIAL_NET.rimRestitution),
            z: ballVel.z + (Math.random() - 0.5) * inSpeed * chaos,
          },
          true
        );
        this.callbacks.onRimHit?.(ballPos.x, ballPos.z, inSpeed);
      } else if (tag === 'obstacle' && this.obstacleHitCooldown <= 0) {
        this.obstacleHitCooldown = 0.2;
        this.callbacks.onObstacleHit?.(ballPos.x, ballPos.y, ballPos.z);
      } else if (tag === 'env') {
        const distFromNet = Math.hypot(ballPos.x, ballPos.z);
        const isElevatedObstacle = ballPos.y > 0.35 && distFromNet > OFFICIAL_NET.rimRadius + 0.25;
        if (isElevatedObstacle && this.obstacleHitCooldown <= 0) {
          this.obstacleHitCooldown = 0.2;
          this.callbacks.onObstacleHit?.(ballPos.x, ballPos.y, ballPos.z);
        } else if (!isElevatedObstacle && this.groundHitCooldown <= 0 && ballPos.y <= OFFICIAL_BALL.radius + 0.08) {
          this.groundHitCooldown = 0.18;
          this.callbacks.onGroundHit?.(ballPos.x, ballPos.z, speed);
        }
      } else if (tag === 'ground' && this.groundHitCooldown <= 0 && ballPos.y <= OFFICIAL_BALL.radius + 0.08) {
        this.groundHitCooldown = 0.18;
        this.callbacks.onGroundHit?.(ballPos.x, ballPos.z, speed);
      }
    });
  }
}
