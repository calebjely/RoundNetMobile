import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import {
  MatchParticipantConfig,
  MOVEMENT_TUNING,
  STARTER_MODEL_PATH,
  TEAM_COLORS,
  TeamId,
  USER_HIGHLIGHT_HEX,
} from '../config/characters';
import { IRF_2026_RULES } from '../config/rules';

export type AnimState =
  | 'idle'
  | 'walk'
  | 'sprint'
  | 'dive'
  | 'get_up'
  | 'block'
  | 'hit_low'
  | 'hit_high'
  | 'spike'
  | 'serve_toss'
  | 'serve_hit';

interface LoadedTemplate {
  scene: THREE.Object3D;
  animations: THREE.AnimationClip[];
}

let cachedTemplatePromise: Promise<LoadedTemplate | null> | null = null;

async function loadStarterTemplate(): Promise<LoadedTemplate | null> {
  if (!cachedTemplatePromise) {
    cachedTemplatePromise = (async () => {
      try {
        const head = await fetch(STARTER_MODEL_PATH, { method: 'HEAD' });
        if (!head.ok || head.headers.get('content-type')?.includes('text/html')) {
          return null;
        }
        const loader = new GLTFLoader();
        const gltf = await loader.loadAsync(STARTER_MODEL_PATH);
        return { scene: gltf.scene, animations: gltf.animations || [] };
      } catch {
        return null;
      }
    })();
  }
  return cachedTemplatePromise;
}

export class CharacterController {
  public readonly config: MatchParticipantConfig;
  public readonly team: TeamId;
  public readonly isHuman: boolean;
  public readonly root: THREE.Group;

  public position = new THREE.Vector3();
  public velocity = new THREE.Vector3();
  public facingAngle = 0;
  public stamina = MOVEMENT_TUNING.maxStamina;
  public isExhausted = false;
  public isSprinting = false;
  public isBlocking = false;
  public isDiving = false;
  public isGettingUp = false;
  public returnToNetActive = false;

  private diveTimer = 0;
  private getUpTimer = 0;
  private diveDir = new THREE.Vector3();
  private actionLockTimer = 0;
  private nhzFollowThroughTimer = 0;

  private animState: AnimState = 'idle';
  private mixer: THREE.AnimationMixer | null = null;
  private actions = new Map<AnimState, THREE.AnimationAction>();
  private currentAction: THREE.AnimationAction | null = null;

  // Mixamo skeleton bone bindings for procedural animation when .glb has no embedded clips
  private mixamoRig: {
    modelRoot: THREE.Object3D;
    baseY: number;
    bones: Map<string, { bone: THREE.Object3D; restQuat: THREE.Quaternion; restPos: THREE.Vector3 }>;
  } | null = null;

  // Articulated fallback rig parts for procedural animation
  private fallbackParts: {
    bodyGroup: THREE.Group;
    leftArm: THREE.Object3D;
    rightArm: THREE.Object3D;
    leftLeg: THREE.Object3D;
    rightLeg: THREE.Object3D;
    head: THREE.Object3D;
  } | null = null;
  private animClock = 0;
  private staminaRingMesh: THREE.Mesh | null = null;
  private staminaRingMat: THREE.MeshBasicMaterial | null = null;
  private readonly staminaSegments = 36;

  constructor(config: MatchParticipantConfig, scene: THREE.Scene) {
    this.config = config;
    this.team = config.team;
    this.isHuman = config.isHuman;
    this.root = new THREE.Group();
    this.root.name = `player_${config.profile.id}`;
    this.position.set(...config.startPos);
    this.root.position.copy(this.position);

    // Face the center net initially
    this.facingAngle = Math.atan2(-this.position.x, -this.position.z);
    this.root.rotation.y = this.facingAngle;

    this.createFootRing();
    this.createNameplate();
    scene.add(this.root);
  }

  public async initModel(): Promise<void> {
    const template = await loadStarterTemplate();
    if (template) {
      const cloned = SkeletonUtils.clone(template.scene);
      const bones = new Map<
        string,
        { bone: THREE.Object3D; restQuat: THREE.Quaternion; restPos: THREE.Vector3 }
      >();

      cloned.traverse((obj) => {
        if (obj.name.startsWith('mixamorig')) {
          bones.set(obj.name, {
            bone: obj,
            restQuat: obj.quaternion.clone(),
            restPos: obj.position.clone(),
          });
        }
        if (obj instanceof THREE.Mesh) {
          obj.castShadow = true;
          obj.receiveShadow = true;
          obj.frustumCulled = false;
          const name = obj.name.toLowerCase();
          if (name.includes('shirt') || name.includes('torso') || name.includes('top')) {
            const mat = (obj.material as THREE.MeshStandardMaterial).clone();
            mat.color.setHex(TEAM_COLORS[this.team].hex);
            mat.emissive.setHex(TEAM_COLORS[this.team].hex);
            mat.emissiveIntensity = 0.16;
            obj.material = mat;
          }
        }
      });

      // Normalize vertical placement so feet sit cleanly on y = 0
      const bbox = new THREE.Box3().setFromObject(cloned);
      if (Number.isFinite(bbox.min.y)) {
        cloned.position.y -= bbox.min.y;
      }

      this.root.add(cloned);

      if (template.animations.length > 0) {
        this.mixer = new THREE.AnimationMixer(cloned);
        const slotNames: AnimState[] = [
          'idle',
          'walk',
          'sprint',
          'dive',
          'get_up',
          'block',
          'hit_low',
          'hit_high',
          'spike',
          'serve_toss',
          'serve_hit',
        ];
        for (const slot of slotNames) {
          const clip = template.animations.find((c) => c.name.toLowerCase().includes(slot));
          if (clip) {
            this.actions.set(slot, this.mixer.clipAction(clip));
          }
        }
        this.setAnimState('idle');
      } else if (bones.size > 0) {
        this.mixamoRig = { modelRoot: cloned, baseY: cloned.position.y, bones };
      }
      return;
    }

    // Procedural articulated humanoid fallback
    this.buildFallbackHumanoid();
  }

  private buildFallbackHumanoid(): void {
    const teamHex = TEAM_COLORS[this.team].hex;
    const shirtMat = new THREE.MeshStandardMaterial({ color: teamHex, roughness: 0.55 });
    const shortsMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.7 });
    const skinMat = new THREE.MeshStandardMaterial({ color: 0xe8be9e, roughness: 0.65 });

    const bodyGroup = new THREE.Group();

    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.18, 0.36, 6, 12), shirtMat);
    torso.position.y = 1.05;
    torso.castShadow = true;
    bodyGroup.add(torso);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.135, 14, 14), skinMat);
    head.position.y = 1.52;
    head.castShadow = true;
    bodyGroup.add(head);

    const createLimb = (radius: number, len: number, mat: THREE.Material, x: number, y: number) => {
      const pivot = new THREE.Group();
      pivot.position.set(x, y, 0);
      const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, len, 4, 8), mat);
      mesh.position.y = -len * 0.5 - radius * 0.5;
      mesh.castShadow = true;
      pivot.add(mesh);
      bodyGroup.add(pivot);
      return pivot;
    };

    const leftArm = createLimb(0.055, 0.42, skinMat, -0.25, 1.28);
    const rightArm = createLimb(0.055, 0.42, skinMat, 0.25, 1.28);
    const leftLeg = createLimb(0.075, 0.58, shortsMat, -0.11, 0.76);
    const rightLeg = createLimb(0.075, 0.58, shortsMat, 0.11, 0.76);

    this.root.add(bodyGroup);
    this.fallbackParts = { bodyGroup, leftArm, rightArm, leftLeg, rightLeg, head };
  }

  private createFootRing(): void {
    const color = this.isHuman ? USER_HIGHLIGHT_HEX : TEAM_COLORS[this.team].ringHex;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.36, 0.44, 32),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: this.isHuman ? 0.9 : 0.65,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.015;
    this.root.add(ring);

    if (this.isHuman) {
      // Background track for stamina ring
      const track = new THREE.Mesh(
        new THREE.RingGeometry(0.46, 0.54, this.staminaSegments),
        new THREE.MeshBasicMaterial({
          color: 0x0f172a,
          transparent: true,
          opacity: 0.55,
          side: THREE.DoubleSide,
          depthWrite: false,
        })
      );
      track.rotation.x = -Math.PI / 2;
      track.position.y = 0.016;
      this.root.add(track);

      // Filling stamina arc ring (zero-GC via setDrawRange)
      const staminaGeo = new THREE.RingGeometry(0.46, 0.54, this.staminaSegments);
      this.staminaRingMat = new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.95,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      this.staminaRingMesh = new THREE.Mesh(staminaGeo, this.staminaRingMat);
      this.staminaRingMesh.rotation.x = -Math.PI / 2;
      this.staminaRingMesh.position.y = 0.018;
      this.root.add(this.staminaRingMesh);
    }
  }

  private createNameplate(): void {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;

    ctx.fillStyle = 'rgba(15, 23, 42, 0.72)';
    ctx.beginPath();
    ctx.roundRect(16, 10, 224, 44, 14);
    ctx.fill();

    ctx.strokeStyle = this.isHuman ? '#facc15' : TEAM_COLORS[this.team].primary;
    ctx.lineWidth = 4;
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 26px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.config.profile.name, 128, 33);

    const tex = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      })
    );
    sprite.renderOrder = 99;
    sprite.position.set(0, 2.02, 0);
    sprite.scale.set(1.15, 0.29, 1);
    this.root.add(sprite);
  }

  public setAnimState(next: AnimState, oneShotDuration = 0): void {
    if (this.animState === next && oneShotDuration === 0) return;
    this.animState = next;
    if (oneShotDuration > 0) {
      this.actionLockTimer = oneShotDuration;
    }

    const nextAction = this.actions.get(next);
    if (this.mixer && nextAction) {
      if (this.currentAction && this.currentAction !== nextAction) {
        this.currentAction.fadeOut(0.14);
      }
      nextAction.reset().fadeIn(0.14).play();
      if (oneShotDuration > 0) {
        nextAction.setLoop(THREE.LoopOnce, 1);
        nextAction.clampWhenFinished = true;
      } else {
        nextAction.setLoop(THREE.LoopRepeat, Infinity);
      }
      this.currentAction = nextAction;
    }
  }

  public triggerDive(direction: THREE.Vector3): void {
    if (this.isDiving || this.isGettingUp) return;
    this.isDiving = true;
    this.isBlocking = false;
    this.diveTimer = MOVEMENT_TUNING.diveDuration;
    this.diveDir.copy(direction).setY(0);
    if (this.diveDir.lengthSq() < 0.001) {
      this.diveDir.set(Math.sin(this.facingAngle), 0, Math.cos(this.facingAngle));
    } else {
      this.diveDir.normalize();
    }
    this.facingAngle = Math.atan2(this.diveDir.x, this.diveDir.z);
    this.setAnimState('dive', MOVEMENT_TUNING.diveDuration);
  }

  public markNHZFollowThrough(): void {
    this.nhzFollowThroughTimer = 0.65;
  }

  public hasActiveNHZFollowThrough(): boolean {
    return this.nhzFollowThroughTimer > 0;
  }

  public isInsideNHZ(): boolean {
    return Math.hypot(this.position.x, this.position.z) < IRF_2026_RULES.noHitZoneRadius;
  }

  public getEffectiveReach(): number {
    const longMod = this.config.profile.stats.longGame;
    return MOVEMENT_TUNING.hitReachRadius * (0.9 + 0.1 * longMod) + (this.isDiving ? MOVEMENT_TUNING.diveReachBonus : 0);
  }

  public resetToStart(): void {
    this.position.set(...this.config.startPos);
    this.velocity.set(0, 0, 0);
    this.stamina = MOVEMENT_TUNING.maxStamina * this.config.profile.stats.stamina;
    this.isExhausted = false;
    this.isSprinting = false;
    this.isBlocking = false;
    this.isDiving = false;
    this.isGettingUp = false;
    this.returnToNetActive = false;
    this.diveTimer = 0;
    this.getUpTimer = 0;
    this.actionLockTimer = 0;
    this.nhzFollowThroughTimer = 0;
    this.facingAngle = Math.atan2(-this.position.x, -this.position.z);
    this.root.position.copy(this.position);
    this.root.rotation.y = this.facingAngle;
    this.setAnimState('idle');
  }

  /**
   * Updates movement, stamina, dive/get_up timers, and animation state machine.
   * @param moveInput normalized 2D intent vector (x, z)
   * @param deflection 0..1 joystick deflection (0..0.55 walk, 0.55..1.0 sprint)
   * @param restrictToQuarterSlice when true (pre-serve), clamps player inside their 90° quarter slice behind the 2.60 m service line
   */
  public update(
    dt: number,
    moveInput: THREE.Vector2,
    deflection: number,
    restrictToQuarterSlice = false
  ): void {
    this.animClock += dt;
    this.nhzFollowThroughTimer = Math.max(0, this.nhzFollowThroughTimer - dt);
    if (this.actionLockTimer > 0) {
      this.actionLockTimer = Math.max(0, this.actionLockTimer - dt);
    }

    const maxStam = MOVEMENT_TUNING.maxStamina * this.config.profile.stats.stamina;
    const speedStat = this.config.profile.stats.speed;

    if (this.isDiving) {
      this.diveTimer -= dt;
      this.velocity.copy(this.diveDir).multiplyScalar(MOVEMENT_TUNING.diveSpeedBoost * speedStat);
      if (this.diveTimer <= 0) {
        this.isDiving = false;
        this.isGettingUp = true;
        this.getUpTimer = MOVEMENT_TUNING.getUpDuration;
        this.setAnimState('get_up', MOVEMENT_TUNING.getUpDuration);
      }
    } else if (this.isGettingUp) {
      this.getUpTimer -= dt;
      this.velocity.multiplyScalar(0.8);
      if (this.getUpTimer <= 0) {
        this.isGettingUp = false;
      }
    } else if (this.isBlocking) {
      this.velocity.multiplyScalar(0.72);
      this.facingAngle = Math.atan2(-this.position.x, -this.position.z);
      this.setAnimState('block');
      this.stamina = Math.min(maxStam, this.stamina + MOVEMENT_TUNING.staminaRegenPerSec * 0.5 * dt);
    } else {
      const mag = Math.min(1, moveInput.length());
      if (mag > 0.04) {
        const wantsSprint = deflection > 0.55 && !this.isExhausted;
        let targetSpeed: number;
        if (wantsSprint) {
          const t = (deflection - 0.55) / 0.45;
          targetSpeed = THREE.MathUtils.lerp(
            MOVEMENT_TUNING.baseFastWalkSpeed,
            MOVEMENT_TUNING.baseSprintSpeed,
            t
          );
          this.isSprinting = true;
          this.stamina = Math.max(0, this.stamina - MOVEMENT_TUNING.staminaDrainPerSec * dt);
          if (this.stamina <= 0.5) {
            this.isExhausted = true;
          }
        } else {
          const walkRatio = Math.min(1, deflection / 0.55);
          const capSpeed = this.isExhausted
            ? MOVEMENT_TUNING.baseFastWalkSpeed
            : MOVEMENT_TUNING.baseWalkSpeed;
          targetSpeed = THREE.MathUtils.lerp(1.4, capSpeed, walkRatio);
          this.isSprinting = false;
          this.stamina = Math.min(maxStam, this.stamina + MOVEMENT_TUNING.staminaRegenPerSec * 0.65 * dt);
        }

        targetSpeed *= speedStat;
        const nx = moveInput.x / mag;
        const nz = moveInput.y / mag;
        this.velocity.x = THREE.MathUtils.lerp(this.velocity.x, nx * targetSpeed, 1 - Math.exp(-dt * 14));
        this.velocity.z = THREE.MathUtils.lerp(this.velocity.z, nz * targetSpeed, 1 - Math.exp(-dt * 14));

        const targetFacing = Math.atan2(nx, nz);
        let diff = targetFacing - this.facingAngle;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        this.facingAngle += diff * (1 - Math.exp(-dt * 12));

        if (this.actionLockTimer <= 0) {
          this.setAnimState(this.isSprinting ? 'sprint' : 'walk');
        }
      } else {
        this.isSprinting = false;
        this.velocity.multiplyScalar(Math.exp(-dt * 14));
        this.stamina = Math.min(maxStam, this.stamina + MOVEMENT_TUNING.staminaRegenPerSec * dt);
        if (this.actionLockTimer <= 0) {
          this.setAnimState('idle');
        }
      }

      if (this.isExhausted && this.stamina >= MOVEMENT_TUNING.staminaRecoverThreshold) {
        this.isExhausted = false;
      }
    }

    this.position.addScaledVector(this.velocity, dt);

    // Keep player outside physical net rim cylinder (0.48 m) and inside outer playable fence (9.6 m)
    let distFromCenter = Math.hypot(this.position.x, this.position.z);
    const minRadius = restrictToQuarterSlice ? IRF_2026_RULES.serviceLineRadius + 0.05 : 0.56;
    if (distFromCenter < minRadius && distFromCenter > 0.001) {
      const push = minRadius / distFromCenter;
      this.position.x *= push;
      this.position.z *= push;
      distFromCenter = minRadius;
    }
    const maxBounds = restrictToQuarterSlice ? IRF_2026_RULES.outerBoundaryRadius : 9.5;
    if (distFromCenter > maxBounds) {
      const clamp = maxBounds / distFromCenter;
      this.position.x *= clamp;
      this.position.z *= clamp;
      distFromCenter = maxBounds;
    }

    // Clamp to 90° quarter ("pizza slice") before the serve is struck
    if (restrictToQuarterSlice && distFromCenter > 0.001) {
      const centerAngle = this.config.quarterCenterAngle;
      const curAngle = Math.atan2(this.position.x, this.position.z);
      let delta = curAngle - centerAngle;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;

      const halfSlice = Math.PI / 4 - 0.04; // 45° half-width with slight player radius margin
      if (Math.abs(delta) > halfSlice) {
        const clampedAngle = centerAngle + Math.sign(delta) * halfSlice;
        this.position.x = Math.sin(clampedAngle) * distFromCenter;
        this.position.z = Math.cos(clampedAngle) * distFromCenter;
      }
    }

    this.root.position.copy(this.position);
    this.root.rotation.y = this.facingAngle;

    if (this.staminaRingMesh && this.staminaRingMat) {
      const pct = THREE.MathUtils.clamp(this.stamina / maxStam, 0, 1);
      const activeSegs = Math.round(pct * this.staminaSegments);
      this.staminaRingMesh.geometry.setDrawRange(0, activeSegs * 6);
      this.staminaRingMat.color.setHex(this.isExhausted ? 0xef4444 : 0x38bdf8);
    }

    if (this.mixer) {
      this.mixer.update(dt);
    }
    this.updateMixamoProceduralRig();
    this.updateProceduralRig();
  }

  private setBoneDelta(name: string, rx: number, ry: number, rz: number): void {
    const entry = this.mixamoRig?.bones.get(name);
    if (!entry) return;
    const delta = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'XYZ'));
    entry.bone.quaternion.copy(entry.restQuat).multiply(delta);
  }

  private updateMixamoProceduralRig(): void {
    if (!this.mixamoRig) return;
    const t = this.animClock;

    // Reset all driven bones to rest pose first
    for (const entry of this.mixamoRig.bones.values()) {
      entry.bone.quaternion.copy(entry.restQuat);
    }
    this.mixamoRig.modelRoot.rotation.set(0, 0, 0);
    this.mixamoRig.modelRoot.position.y = this.mixamoRig.baseY;

    // Natural athletic arms-down base pose (out of Mixamo T-pose)
    let lArmX = 1.12;
    let rArmX = 1.12;
    let lArmZ = 0.16;
    let rArmZ = -0.16;
    let lForeZ = 0.42;
    let rForeZ = -0.42;
    let lThighX = 0.08;
    let rThighX = 0.08;
    let lKneeX = -0.16;
    let rKneeX = -0.16;
    let spineX = 0.1;

    switch (this.animState) {
      case 'idle': {
        const breathe = Math.sin(t * 2.5) * 0.04;
        spineX = 0.12 + breathe * 0.5;
        lArmX = 1.08 + breathe;
        rArmX = 1.08 + breathe;
        lForeZ = 0.55;
        rForeZ = -0.55;
        break;
      }
      case 'walk':
      case 'sprint': {
        const isSprint = this.animState === 'sprint';
        const freq = isSprint ? 12.5 : 7.5;
        const stride = isSprint ? 0.85 : 0.48;
        const s = Math.sin(t * freq);
        const c = Math.cos(t * freq);

        spineX = isSprint ? 0.28 : 0.12;
        lThighX = s * stride;
        rThighX = -s * stride;
        lKneeX = -Math.max(0.08, -c * (isSprint ? 1.1 : 0.65));
        rKneeX = -Math.max(0.08, c * (isSprint ? 1.1 : 0.65));

        lArmX = 1.18;
        rArmX = 1.18;
        lArmZ = -s * (isSprint ? 0.75 : 0.4);
        rArmZ = -s * (isSprint ? 0.75 : 0.4);
        lForeZ = isSprint ? 1.15 : 0.55;
        rForeZ = isSprint ? -1.15 : -0.55;
        this.mixamoRig.modelRoot.position.y =
          this.mixamoRig.baseY + Math.abs(s) * (isSprint ? 0.06 : 0.025);
        break;
      }
      case 'dive': {
        this.mixamoRig.modelRoot.rotation.x = Math.PI * 0.42;
        this.mixamoRig.modelRoot.position.y = this.mixamoRig.baseY + 0.34;
        lArmX = -0.45;
        rArmX = -0.45;
        lArmZ = 0.55;
        rArmZ = -0.55;
        lForeZ = 0.15;
        rForeZ = -0.15;
        lThighX = -0.25;
        rThighX = -0.25;
        break;
      }
      case 'get_up': {
        spineX = 0.55;
        lThighX = 0.55;
        rThighX = 0.35;
        lKneeX = -0.85;
        rKneeX = -0.65;
        break;
      }
      case 'block': {
        spineX = 0.05;
        lArmX = -1.15;
        rArmX = -1.15;
        lArmZ = 0.22;
        rArmZ = -0.22;
        lForeZ = 0.2;
        rForeZ = -0.2;
        break;
      }
      case 'spike':
      case 'serve_hit': {
        spineX = 0.25;
        rArmX = -1.05;
        rArmZ = -0.55;
        rForeZ = -0.25;
        lArmX = 0.95;
        lArmZ = 0.2;
        break;
      }
      case 'hit_high':
      case 'serve_toss': {
        spineX = 0.08;
        rArmX = 0.35;
        rArmZ = -0.75;
        rForeZ = -0.55;
        lArmX = 0.55;
        lArmZ = 0.55;
        break;
      }
      case 'hit_low': {
        spineX = 0.42;
        lArmX = 0.85;
        rArmX = 0.85;
        lArmZ = 0.65;
        rArmZ = -0.65;
        lThighX = 0.42;
        rThighX = 0.42;
        lKneeX = -0.68;
        rKneeX = -0.68;
        break;
      }
    }

    this.setBoneDelta('mixamorig:Spine', spineX, 0, 0);
    this.setBoneDelta('mixamorig:LeftArm', lArmX, 0, lArmZ);
    this.setBoneDelta('mixamorig:RightArm', rArmX, 0, rArmZ);
    this.setBoneDelta('mixamorig:LeftForeArm', 0, 0, lForeZ);
    this.setBoneDelta('mixamorig:RightForeArm', 0, 0, rForeZ);
    this.setBoneDelta('mixamorig:LeftUpLeg', lThighX, 0, 0);
    this.setBoneDelta('mixamorig:RightUpLeg', rThighX, 0, 0);
    this.setBoneDelta('mixamorig:LeftLeg', lKneeX, 0, 0);
    this.setBoneDelta('mixamorig:RightLeg', rKneeX, 0, 0);
  }

  private updateProceduralRig(): void {
    if (!this.fallbackParts) return;
    const { bodyGroup, leftArm, rightArm, leftLeg, rightLeg } = this.fallbackParts;
    const t = this.animClock;

    // Reset transforms smoothly
    bodyGroup.rotation.set(0, 0, 0);
    bodyGroup.position.set(0, 0, 0);
    leftArm.rotation.set(0, 0, 0);
    rightArm.rotation.set(0, 0, 0);
    leftLeg.rotation.set(0, 0, 0);
    rightLeg.rotation.set(0, 0, 0);

    switch (this.animState) {
      case 'idle': {
        const bob = Math.sin(t * 2.4) * 0.015;
        bodyGroup.position.y = bob;
        leftArm.rotation.z = 0.14;
        rightArm.rotation.z = -0.14;
        break;
      }
      case 'walk':
      case 'sprint': {
        const freq = this.animState === 'sprint' ? 12 : 7;
        const amp = this.animState === 'sprint' ? 0.72 : 0.4;
        const swing = Math.sin(t * freq) * amp;
        leftLeg.rotation.x = swing;
        rightLeg.rotation.x = -swing;
        leftArm.rotation.x = -swing * 0.85;
        rightArm.rotation.x = swing * 0.85;
        bodyGroup.position.y = Math.abs(Math.sin(t * freq)) * (this.animState === 'sprint' ? 0.06 : 0.025);
        bodyGroup.rotation.x = this.animState === 'sprint' ? 0.16 : 0.06;
        break;
      }
      case 'dive': {
        bodyGroup.rotation.x = Math.PI * 0.42;
        bodyGroup.position.y = 0.28;
        leftArm.rotation.x = -Math.PI * 0.85;
        rightArm.rotation.x = -Math.PI * 0.85;
        break;
      }
      case 'get_up': {
        bodyGroup.rotation.x = 0.5;
        bodyGroup.position.y = 0.12;
        break;
      }
      case 'block': {
        leftArm.rotation.x = -Math.PI * 0.82;
        rightArm.rotation.x = -Math.PI * 0.82;
        leftArm.rotation.z = 0.18;
        rightArm.rotation.z = -0.18;
        break;
      }
      case 'spike':
      case 'serve_hit': {
        rightArm.rotation.x = -Math.PI * 0.9;
        bodyGroup.rotation.x = 0.22;
        break;
      }
      case 'hit_high':
      case 'serve_toss': {
        rightArm.rotation.x = -Math.PI * 0.55;
        leftArm.rotation.x = -Math.PI * 0.35;
        break;
      }
      case 'hit_low': {
        bodyGroup.rotation.x = 0.28;
        rightArm.rotation.x = -0.7;
        leftArm.rotation.x = -0.7;
        break;
      }
    }
  }
}
