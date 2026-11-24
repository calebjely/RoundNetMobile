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

    // Trampoline netting disc
    const netDiscRadius = rimRadius - rimTubeRadius * 0.9;
    const netColDesc = RAPIER.ColliderDesc.cylinder(0.012, netDiscRadius)
      .setTranslation(0, netHeight, 0)
      .setRestitution(0.1) // Handled manually for crisp elastic trampoline rebound
      .setFriction(0.15);
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

      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -midA + Math.PI / 2);
      const rimColDesc = RAPIER.ColliderDesc.cuboid(segLen * 0.52, rimTubeRadius, rimTubeRadius)
        .setTranslation(cx, netHeight, cz)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setRestitution(OFFICIAL_NET.rimRestitution)
        .setFriction(0.3);
      const rimCol = this.world.createCollider(rimColDesc, body);
      this.colliderTags.set(rimCol.handle, 'rim');
    }

    // 5 Radial Legs (also rim-tagged so hitting side of set deflects unpredictably)
    for (let i = 0; i < legCount; i++) {
      const angle = (i / legCount) * Math.PI * 2;
      const legColDesc = RAPIER.ColliderDesc.cylinder(netHeight * 0.5, 0.022)
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
    // Clear previous env colliders if reloading
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
      if (obj.name === 'ground_lawn') return; // Handled by clean ground plane

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
    this.ballBody.setTranslation({ x: pos.x, y: pos.y, z: pos.z }, wake);
    this.ballBody.setLinvel({ x: vel.x, y: vel.y, z: vel.z }, wake);
    this.ballBody.setAngvel({ x: 0, y: 0, z: 0 }, wake);
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

    // Aerodynamic quadratic drag for realistic hang-time on passes/sets while keeping spikes crisp
    const vel = this.ballBody.linvel();
    const speed = Math.hypot(vel.x, vel.y, vel.z);
    if (speed > 0.05) {
      const dragFactor = 1 - Math.min(0.25, OFFICIAL_BALL.airDrag * speed * dt);
      this.ballBody.setLinvel(
        { x: vel.x * dragFactor, y: vel.y * dragFactor, z: vel.z * dragFactor },
        true
      );
    }

    this.world.timestep = Math.min(dt, 1 / 60);
    this.world.step();

    this.processContacts();
  }

  private processContacts(): void {
    const ballPos = this.ballBody.translation();
    const ballVel = this.ballBody.linvel();
    const speed = Math.hypot(ballVel.x, ballVel.y, ballVel.z);

    this.world.contactPairsWith(this.ballCollider, (other) => {
      const tag = this.colliderTags.get(other.handle);
      if (!tag) return;

      if (tag === 'net' && this.netHitCooldown <= 0) {
        if (ballVel.y < -0.05) {
          this.netHitCooldown = 0.12;
          // Fast incoming shots slow horizontally off the net and pop high into a real arc
          const newVy = Math.max(
            3.8,
            Math.abs(ballVel.y) * OFFICIAL_NET.netRestitution + speed * 0.22
          );
          this.ballBody.setLinvel(
            {
              x: ballVel.x * OFFICIAL_NET.netHorizontalDamping,
              y: newVy,
              z: ballVel.z * OFFICIAL_NET.netHorizontalDamping,
            },
            true
          );
          this.ballBody.setTranslation(
            {
              x: ballPos.x,
              y: Math.max(ballPos.y, OFFICIAL_NET.netHeight + OFFICIAL_BALL.radius + 0.015),
              z: ballPos.z,
            },
            true
          );
          this.callbacks.onNetHit?.(ballPos.x, ballPos.z, speed);
        }
      } else if (tag === 'rim' && this.rimHitCooldown <= 0) {
        this.rimHitCooldown = 0.12;
        const chaos = OFFICIAL_NET.rimChaosFactor;
        this.ballBody.setLinvel(
          {
            x: ballVel.x + (Math.random() - 0.5) * speed * chaos,
            y: Math.max(1.2, Math.abs(ballVel.y) * OFFICIAL_NET.rimRestitution),
            z: ballVel.z + (Math.random() - 0.5) * speed * chaos,
          },
          true
        );
        this.callbacks.onRimHit?.(ballPos.x, ballPos.z, speed);
      } else if (tag === 'obstacle' && this.obstacleHitCooldown <= 0) {
        this.obstacleHitCooldown = 0.2;
        this.callbacks.onObstacleHit?.(ballPos.x, ballPos.y, ballPos.z);
      } else if (tag === 'env') {
        // Classify env triangle by elevation/steepness: elevated outside net = obstacle, low flat = ground
        const distFromNet = Math.hypot(ballPos.x, ballPos.z);
        const isElevatedObstacle = ballPos.y > 0.35 && distFromNet > OFFICIAL_NET.rimRadius + 0.25;
        if (isElevatedObstacle && this.obstacleHitCooldown <= 0) {
          this.obstacleHitCooldown = 0.2;
          this.callbacks.onObstacleHit?.(ballPos.x, ballPos.y, ballPos.z);
        } else if (!isElevatedObstacle && this.groundHitCooldown <= 0 && ballVel.y < 0.2) {
          this.groundHitCooldown = 0.15;
          this.callbacks.onGroundHit?.(ballPos.x, ballPos.z, speed);
        }
      } else if (tag === 'ground' && this.groundHitCooldown <= 0 && ballPos.y <= OFFICIAL_BALL.radius + 0.08) {
        this.groundHitCooldown = 0.15;
        this.callbacks.onGroundHit?.(ballPos.x, ballPos.z, speed);
      }
    });
  }
}
