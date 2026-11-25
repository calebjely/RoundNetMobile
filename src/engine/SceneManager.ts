import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { OFFICIAL_BALL, OFFICIAL_NET } from '../config/equipment';
import { IRF_2026_RULES } from '../config/rules';
import {
  CameraPreset,
  CourtOffsetConfig,
  IntroCameraStyle,
  MapConfig,
  SavedCourtConfig,
} from '../config/maps';

export interface SceneLoadResult {
  splatLoaded: boolean;
  collisionRoot: THREE.Object3D | null;
  usingProceduralFallback: boolean;
}

export interface OffscreenLandingHint {
  visible: boolean;
  screenX: number;
  screenY: number;
  angleDeg: number;
  teamColor: string;
}

export interface FirstPersonHints {
  netEdge: OffscreenLandingHint;
  partnerEdge: OffscreenLandingHint;
}

function smoothDampScalar(
  current: number,
  target: number,
  vel: { v: number },
  smoothTime: number,
  dt: number,
  maxSpeed = Infinity
): number {
  const st = Math.max(0.0001, smoothTime);
  const omega = 2 / st;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  let change = current - target;
  const maxChange = maxSpeed * st;
  change = THREE.MathUtils.clamp(change, -maxChange, maxChange);
  const clampedTarget = current - change;
  const temp = (vel.v + omega * change) * dt;
  vel.v = (vel.v - omega * temp) * exp;
  let output = clampedTarget + (change + temp) * exp;
  if (target - current > 0 === output > target) {
    output = target;
    vel.v = (output - target) / Math.max(1e-5, dt);
  }
  return output;
}

function smoothDampAngle(
  current: number,
  target: number,
  vel: { v: number },
  smoothTime: number,
  dt: number
): number {
  let delta = ((target - current + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return smoothDampScalar(current, current + delta, vel, smoothTime, dt);
}

export class SceneManager {
  public readonly scene: THREE.Scene;
  public readonly camera: THREE.PerspectiveCamera;
  public readonly renderer: THREE.WebGLRenderer;
  public readonly spark: SparkRenderer;
  public readonly courtGroup: THREE.Group;
  public readonly ballMesh: THREE.Mesh;
  public readonly netGroup: THREE.Group;
  public readonly orbitControls: OrbitControls;

  private readonly mapConfig: MapConfig;
  private courtOffset: CourtOffsetConfig;
  private serveCameras: [CameraPreset, CameraPreset, CameraPreset, CameraPreset];
  private activeServeSlot = 0;
  private calibrateMode = false;
  private calibrateTab: 'camera' | 'net' = 'camera';
  private calibrateServeSlot = 0;
  private cameraViewMode: 'pressbox' | 'first_person' = 'first_person';
  private netPointers = new Map<number, { x: number; y: number }>();
  private netPrevPinchDist = 0;
  private onCourtOffsetSync?: (offset: CourtOffsetConfig) => void;
  private onCameraPresetChanged?: () => void;

  // 1st-Person Swinging Arm + Edge Indicators
  private fpArmPivot!: THREE.Group;
  private fpSwingElapsed = -1;
  private fpSwingDuration = 0.28;
  private fpSwingDir = new THREE.Vector2(0, -1);
  private fpBlocking = false;
  private fpHints: FirstPersonHints = {
    netEdge: { visible: false, screenX: 0, screenY: 0, angleDeg: 0, teamColor: '#facc15' },
    partnerEdge: { visible: false, screenX: 0, screenY: 0, angleDeg: 0, teamColor: '#60a5fa' },
  };

  // Starting game cinematic camera intro animation
  private introSpinElapsed = -1;
  private introSpinDuration = 4.2;
  private introStyle: IntroCameraStyle = 'swoop90';

  private netDiscMesh!: THREE.Mesh;
  private netBasePositions!: Float32Array;
  private rippleTime = -1;
  private rippleOrigin = new THREE.Vector2(0, 0);
  private rippleStrength = 0;

  private baseCamPos: THREE.Vector3;
  private baseCamTarget: THREE.Vector3;
  private currentZoomFactor = 1.0;
  private currentCamPos = new THREE.Vector3();
  private currentCamTarget = new THREE.Vector3();

  // Critically damped 1st-person gimbal camera state
  private fpInit = false;
  private fpEyePos = new THREE.Vector3();
  private fpEyeVelX = { v: 0 };
  private fpEyeVelY = { v: 0 };
  private fpEyeVelZ = { v: 0 };
  private fpYaw = 0;
  private fpYawVel = { v: 0 };
  private fpPitch = 0;
  private fpPitchVel = { v: 0 };

  private netHitDotMesh!: THREE.Mesh;
  private netArrowGroup!: THREE.Group;
  private landingRingMesh!: THREE.Mesh;
  private landingRingMat!: THREE.MeshBasicMaterial;
  private landingInnerMesh!: THREE.Mesh;
  private landingInnerMat!: THREE.MeshBasicMaterial;
  private timingRingGroup!: THREE.Group;
  private timingOuterMesh!: THREE.Mesh;
  private timingOuterMat!: THREE.MeshBasicMaterial;
  private timingTargetMesh!: THREE.Mesh;
  private timingTargetMat!: THREE.MeshBasicMaterial;
  private offscreenLandingHint: OffscreenLandingHint = {
    visible: false,
    screenX: 0,
    screenY: 0,
    angleDeg: 0,
    teamColor: '#facc15',
  };

  private proceduralEnvGroup: THREE.Group | null = null;
  private readonly gltfLoader = new GLTFLoader();

  constructor(container: HTMLElement, mapConfig: MapConfig, savedConfig?: SavedCourtConfig) {
    this.mapConfig = mapConfig;
    const initOffset = savedConfig?.courtOffset ?? mapConfig.courtOffset;
    this.courtOffset = {
      position: [...initOffset.position],
      rotationY: initOffset.rotationY,
      scale: initOffset.scale,
    };
    const initCams = savedConfig?.serveCameras ?? mapConfig.serveCameras;
    this.serveCameras = initCams.map((c) => ({
      position: [...c.position] as [number, number, number],
      target: [...c.target] as [number, number, number],
    })) as [CameraPreset, CameraPreset, CameraPreset, CameraPreset];

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x9ec5e8);
    this.scene.fog = new THREE.Fog(0x9ec5e8, 28, 70);

    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;

    this.camera = new THREE.PerspectiveCamera(mapConfig.fov, width / height, 0.1, 150);
    this.baseCamPos = new THREE.Vector3(...this.serveCameras[0].position);
    this.baseCamTarget = new THREE.Vector3(...this.serveCameras[0].target);
    this.currentCamPos.copy(this.baseCamPos);
    this.currentCamTarget.copy(this.baseCamTarget);
    this.camera.position.copy(this.baseCamPos);
    this.camera.lookAt(this.baseCamTarget);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    // Mobile GPU budget: cap pixel ratio at 2
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.02;
    container.appendChild(this.renderer.domElement);

    // Spark 2.0 Setup (Critical): instantiate SparkRenderer before loading any splats
    this.spark = new SparkRenderer({ renderer: this.renderer });
    this.scene.add(this.spark);

    this.orbitControls = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbitControls.target.copy(this.baseCamTarget);
    this.orbitControls.enableDamping = true;
    this.orbitControls.dampingFactor = 0.08;
    this.orbitControls.enabled = false;
    this.orbitControls.addEventListener('end', this.onOrbitEnd);

    const dom = this.renderer.domElement;
    dom.addEventListener('pointerdown', this.onNetCalPointerDown);
    window.addEventListener('pointermove', this.onNetCalPointerMove);
    window.addEventListener('pointerup', this.onNetCalPointerUp);
    window.addEventListener('pointercancel', this.onNetCalPointerUp);
    dom.addEventListener('wheel', this.onNetCalWheel, { passive: false });

    this.courtGroup = new THREE.Group();
    this.courtGroup.name = 'courtGroup';
    this.applyCourtOffset();
    this.scene.add(this.courtGroup);

    this.setupLighting();
    this.createCourtMarkings();
    this.netGroup = this.createOfficialNet();
    this.scene.add(this.netGroup);
    this.createNetDirectionArrow();
    this.createLandingCircle();
    this.createTimingRing();
    this.createFirstPersonArm();
    this.ballMesh = this.createOfficialBall();
    this.scene.add(this.ballMesh);
    this.scene.add(this.camera);

    window.addEventListener('resize', this.handleResize);
  }

  private setupLighting(): void {
    // Neutral overcast lighting to blend cleanly with baked Gaussian Splat lighting
    const hemi = new THREE.HemisphereLight(0xf1f5f9, 0x64748b, 1.15);
    this.scene.add(hemi);

    const dir = new THREE.DirectionalLight(0xffffff, 1.35);
    dir.position.set(5.5, 12.0, 6.5);
    dir.castShadow = true;
    // Conservative 1024x1024 shadow map for mobile GPU performance
    dir.shadow.mapSize.set(1024, 1024);
    dir.shadow.camera.near = 1;
    dir.shadow.camera.far = 32;
    const d = 10.5;
    dir.shadow.camera.left = -d;
    dir.shadow.camera.right = d;
    dir.shadow.camera.top = d;
    dir.shadow.camera.bottom = -d;
    dir.shadow.bias = -0.0005;
    this.scene.add(dir);

    // Invisible ShadowMaterial receiver aligned to play floor so dynamic entities cast shadows onto splat grass
    const shadowPlane = new THREE.Mesh(
      new THREE.CircleGeometry(14, 48),
      new THREE.ShadowMaterial({ opacity: 0.34 })
    );
    shadowPlane.rotation.x = -Math.PI / 2;
    shadowPlane.position.y = 0.003;
    shadowPlane.receiveShadow = true;
    this.scene.add(shadowPlane);
  }

  private createCourtMarkings(): void {
    const createRing = (radius: number, thickness: number, color: number, opacity: number) => {
      const geo = new THREE.RingGeometry(radius - thickness * 0.5, radius + thickness * 0.5, 72);
      const mat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        side: THREE.DoubleSide,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 0.012;
      mesh.renderOrder = 1;
      return mesh;
    };

    // 1.00 m No-Hit Zone (NHZ)
    this.scene.add(createRing(IRF_2026_RULES.noHitZoneRadius, 0.035, 0xf87171, 0.48));
    // 2.60 m Service Line
    this.scene.add(createRing(IRF_2026_RULES.serviceLineRadius, 0.035, 0xffffff, 0.42));
    // 8.50 m Outer Boundary
    this.scene.add(createRing(IRF_2026_RULES.outerBoundaryRadius, 0.05, 0xffffff, 0.3));

    // Quarter ("pizza slice") dividing lines at 45°, 135°, 225°, 315°
    const lineLen = IRF_2026_RULES.outerBoundaryRadius - IRF_2026_RULES.noHitZoneRadius;
    const midR = (IRF_2026_RULES.outerBoundaryRadius + IRF_2026_RULES.noHitZoneRadius) * 0.5;
    const lineGeo = new THREE.PlaneGeometry(0.03, lineLen);
    const lineMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.24,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    for (let i = 0; i < 4; i++) {
      const angle = Math.PI / 4 + (i * Math.PI) / 2;
      const line = new THREE.Mesh(lineGeo, lineMat);
      line.rotation.x = -Math.PI / 2;
      line.rotation.z = -angle;
      line.position.set(Math.sin(angle) * midR, 0.012, Math.cos(angle) * midR);
      line.renderOrder = 1;
      this.scene.add(line);
    }
  }

  private createNetTexture(): THREE.CanvasTexture {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, size, size);

    // Crisp diamond netting grid
    ctx.strokeStyle = 'rgba(20, 20, 20, 0.92)';
    ctx.lineWidth = 3;
    const step = 16;
    for (let i = -size; i < size * 2; i += step) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i + size, size);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i - size, size);
      ctx.stroke();
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(3.5, 3.5);
    return tex;
  }

  private createOfficialNet(): THREE.Group {
    const group = new THREE.Group();
    group.name = 'officialIRFSet';

    const { rimRadius, rimTubeRadius, netHeight, legCount } = OFFICIAL_NET;

    // Yellow Pro Rim Torus
    const rimGeo = new THREE.TorusGeometry(rimRadius, rimTubeRadius, 14, 48);
    const rimMat = new THREE.MeshStandardMaterial({
      color: 0xfacc15,
      roughness: 0.35,
      metalness: 0.1,
    });
    const rimMesh = new THREE.Mesh(rimGeo, rimMat);
    rimMesh.rotation.x = Math.PI / 2;
    rimMesh.position.y = netHeight;
    rimMesh.castShadow = true;
    rimMesh.receiveShadow = true;
    group.add(rimMesh);

    // 5 Radial Black Legs + Rim Hooks
    const legMat = new THREE.MeshStandardMaterial({
      color: 0x18181b,
      roughness: 0.55,
      metalness: 0.2,
    });
    for (let i = 0; i < legCount; i++) {
      const angle = (i / legCount) * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);

      // Vertical post
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.018, 0.022, netHeight, 8),
        legMat
      );
      post.position.set(cos * rimRadius, netHeight * 0.5, sin * rimRadius);
      post.castShadow = true;
      group.add(post);

      // Outward foot
      const foot = new THREE.Mesh(
        new THREE.BoxGeometry(0.04, 0.02, 0.12),
        legMat
      );
      foot.position.set(cos * (rimRadius + 0.03), 0.01, sin * (rimRadius + 0.03));
      foot.rotation.y = -angle + Math.PI / 2;
      foot.castShadow = true;
      group.add(foot);
    }

    // Circular diamond netting disc with vertex-ripple capability
    const netGeo = new THREE.CircleGeometry(rimRadius - rimTubeRadius * 0.6, 28, 0, Math.PI * 2);
    // Subdivide radial rings using Ring/Plane or custom radial grid? CircleGeometry has 1 ring;
    // let's build a subdivided disc using PlaneGeometry clipped or Polar grid for smooth ripples!
    netGeo.dispose();

    const polarGeo = new THREE.BufferGeometry();
    const rings = 8;
    const segs = 28;
    const verts: number[] = [0, 0, 0];
    const uvs: number[] = [0.5, 0.5];
    const indices: number[] = [];
    const maxR = rimRadius - rimTubeRadius * 0.4;

    for (let r = 1; r <= rings; r++) {
      const rad = (r / rings) * maxR;
      for (let s = 0; s < segs; s++) {
        const theta = (s / segs) * Math.PI * 2;
        const x = Math.cos(theta) * rad;
        const z = Math.sin(theta) * rad;
        verts.push(x, 0, z);
        uvs.push(0.5 + (x / maxR) * 0.5, 0.5 + (z / maxR) * 0.5);
      }
    }

    // Center fan
    for (let s = 0; s < segs; s++) {
      const next = (s + 1) % segs;
      indices.push(0, 1 + next, 1 + s);
    }
    // Outer rings
    for (let r = 1; r < rings; r++) {
      const rowStart = 1 + (r - 1) * segs;
      const nextRowStart = 1 + r * segs;
      for (let s = 0; s < segs; s++) {
        const next = (s + 1) % segs;
        const a = rowStart + s;
        const b = rowStart + next;
        const c = nextRowStart + s;
        const d = nextRowStart + next;
        indices.push(a, b, d, a, d, c);
      }
    }

    polarGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    polarGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    polarGeo.setIndex(indices);
    polarGeo.computeVertexNormals();

    this.netBasePositions = new Float32Array(verts);
    const netTex = this.createNetTexture();
    const netMat = new THREE.MeshStandardMaterial({
      map: netTex,
      alphaMap: netTex,
      transparent: true,
      alphaTest: 0.15,
      side: THREE.DoubleSide,
      roughness: 0.8,
    });

    this.netDiscMesh = new THREE.Mesh(polarGeo, netMat);
    this.netDiscMesh.position.y = netHeight;
    this.netDiscMesh.castShadow = true;
    this.netDiscMesh.receiveShadow = true;
    group.add(this.netDiscMesh);

    return group;
  }

  private createBallPipNormalMap(): THREE.CanvasTexture {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'rgb(128, 128, 255)';
    ctx.fillRect(0, 0, size, size);

    // Procedural micro-pips for spin visibility
    const step = 16;
    for (let y = 8; y < size; y += step) {
      for (let x = 8; x < size; x += step) {
        const grad = ctx.createRadialGradient(x - 1, y - 1, 1, x, y, 5);
        grad.addColorStop(0, 'rgb(180, 180, 255)');
        grad.addColorStop(0.6, 'rgb(96, 96, 235)');
        grad.addColorStop(1, 'rgb(128, 128, 255)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(3, 2);
    return tex;
  }

  private createOfficialBall(): THREE.Mesh {
    const geo = new THREE.SphereGeometry(OFFICIAL_BALL.radius, 24, 24);
    const normalMap = this.createBallPipNormalMap();
    const mat = new THREE.MeshStandardMaterial({
      color: OFFICIAL_BALL.colorHex,
      emissive: 0xfacc15,
      emissiveIntensity: 0.24,
      normalMap,
      normalScale: new THREE.Vector2(0.75, 0.75),
      roughness: 0.36,
      metalness: 0.04,
    });

    if (OFFICIAL_BALL.customTextureUrl) {
      new THREE.TextureLoader().load(OFFICIAL_BALL.customTextureUrl, (tex) => {
        mat.map = tex;
        mat.needsUpdate = true;
      });
    }

    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.position.set(0, 1.2, 2.8);
    return mesh;
  }

  public triggerNetRipple(hitX: number, hitZ: number, impactSpeed: number): void {
    this.rippleTime = 0;
    this.rippleOrigin.set(hitX, hitZ);
    this.rippleStrength = Math.min(0.065, Math.max(0.018, impactSpeed * 0.0055));
  }

  public updateNetRipple(dt: number): void {
    if (this.rippleTime < 0) return;
    this.rippleTime += dt;
    const duration = 0.42;
    const posAttr = this.netDiscMesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = posAttr.array as Float32Array;
    const maxR = OFFICIAL_NET.rimRadius - OFFICIAL_NET.rimTubeRadius * 0.4;

    if (this.rippleTime >= duration) {
      arr.set(this.netBasePositions);
      posAttr.needsUpdate = true;
      this.rippleTime = -1;
      return;
    }

    const decay = Math.exp(-this.rippleTime * 7.5);
    const wave = Math.sin(this.rippleTime * 34);
    for (let i = 0; i < arr.length; i += 3) {
      const bx = this.netBasePositions[i];
      const bz = this.netBasePositions[i + 2];
      const rFromCenter = Math.hypot(bx, bz);
      const edgePin = Math.max(0, 1 - (rFromCenter / maxR) ** 2);
      const dHit = Math.hypot(bx - this.rippleOrigin.x, bz - this.rippleOrigin.y);
      const localFalloff = Math.exp(-dHit * 3.5);
      arr[i + 1] = -this.rippleStrength * decay * (0.65 + 0.35 * wave) * edgePin * localFalloff;
    }
    posAttr.needsUpdate = true;
  }

  public async loadMapAssets(): Promise<SceneLoadResult> {
    let splatLoaded = false;
    let collisionRoot: THREE.Object3D | null = null;

    // Check splat availability cleanly without throwing unhandled errors
    try {
      const head = await fetch(this.mapConfig.splatUrl, { method: 'HEAD' });
      if (head.ok && !head.headers.get('content-type')?.includes('text/html')) {
        const splat = new SplatMesh({ url: this.mapConfig.splatUrl });
        this.courtGroup.add(splat);
        splatLoaded = true;
      }
    } catch {
      splatLoaded = false;
    }

    // Check collision GLB availability
    try {
      const head = await fetch(this.mapConfig.collisionUrl, { method: 'HEAD' });
      if (head.ok && !head.headers.get('content-type')?.includes('text/html')) {
        const gltf = await this.gltfLoader.loadAsync(this.mapConfig.collisionUrl);
        gltf.scene.visible = false; // Invisible physics-only mesh over the splat
        this.courtGroup.add(gltf.scene);
        this.courtGroup.updateMatrixWorld(true);
        collisionRoot = gltf.scene;
      }
    } catch {
      collisionRoot = null;
    }

    const usingProceduralFallback = !splatLoaded;
    if (usingProceduralFallback) {
      const fallbackRoot = this.buildProceduralLawnCourt();
      if (!collisionRoot) {
        collisionRoot = fallbackRoot;
      }
    }

    return { splatLoaded, collisionRoot, usingProceduralFallback };
  }

  private buildProceduralLawnCourt(): THREE.Group {
    if (this.proceduralEnvGroup) {
      return this.proceduralEnvGroup;
    }
    const env = new THREE.Group();
    env.name = 'proceduralLawnFallback';

    // Procedural mowed lawn texture
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#4a7c3a';
    ctx.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 16; i++) {
      ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)';
      ctx.fillRect(0, i * 32, 512, 32);
    }
    const grassTex = new THREE.CanvasTexture(canvas);
    grassTex.wrapS = THREE.RepeatWrapping;
    grassTex.wrapT = THREE.RepeatWrapping;
    grassTex.repeat.set(6, 6);

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(24, 64),
      new THREE.MeshStandardMaterial({ map: grassTex, roughness: 0.92 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.name = 'ground_lawn';
    env.add(ground);

    // Perimeter obstacle fences & trees (tagged obstacle_ for Redo interference)
    const fenceMat = new THREE.MeshStandardMaterial({ color: 0x78553a, roughness: 0.85 });
    const postCount = 12;
    const fenceRadius = 10.2;
    for (let i = 0; i < postCount; i++) {
      const angle = (i / postCount) * Math.PI * 2;
      const x = Math.cos(angle) * fenceRadius;
      const z = Math.sin(angle) * fenceRadius;

      const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.15, 0.18), fenceMat);
      post.position.set(x, 0.575, z);
      post.castShadow = true;
      post.name = `obstacle_fence_post_${i}`;
      env.add(post);

      // Rail to next post (leave a small gap on camera side for unobstructed view)
      if (Math.sin(angle) < 0.65) {
        const nextAngle = ((i + 1) / postCount) * Math.PI * 2;
        const nx = Math.cos(nextAngle) * fenceRadius;
        const nz = Math.sin(nextAngle) * fenceRadius;
        const mx = (x + nx) * 0.5;
        const mz = (z + nz) * 0.5;
        const len = Math.hypot(nx - x, nz - z);
        const rail = new THREE.Mesh(new THREE.BoxGeometry(len, 0.1, 0.08), fenceMat);
        rail.position.set(mx, 0.85, mz);
        rail.rotation.y = -Math.atan2(nz - z, nx - x);
        rail.castShadow = true;
        rail.name = `obstacle_fence_rail_${i}`;
        env.add(rail);
      }
    }

    // Perimeter trees (tagged obstacle_)
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5c4033, roughness: 0.9 });
    const foliageMat = new THREE.MeshStandardMaterial({ color: 0x2f6b2f, roughness: 0.85 });
    const treeCoords: [number, number][] = [
      [-11.5, -8.5],
      [11.5, -8.0],
      [-12.5, 2.5],
      [12.5, 3.0],
      [0, -12.5],
    ];
    treeCoords.forEach(([tx, tz], idx) => {
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.36, 2.2, 8), trunkMat);
      trunk.position.set(tx, 1.1, tz);
      trunk.castShadow = true;
      trunk.name = `obstacle_tree_trunk_${idx}`;
      env.add(trunk);

      const crown = new THREE.Mesh(new THREE.DodecahedronGeometry(1.65, 1), foliageMat);
      crown.position.set(tx, 3.1, tz);
      crown.castShadow = true;
      crown.name = `obstacle_tree_crown_${idx}`;
      env.add(crown);
    });

    this.courtGroup.add(env);
    this.courtGroup.updateMatrixWorld(true);
    this.proceduralEnvGroup = env;
    return env;
  }

  private createFirstPersonArm(): void {
    const pivot = new THREE.Group();
    pivot.position.set(0.28, -0.26, -0.34);
    pivot.visible = this.cameraViewMode === 'first_person';

    const sleeveMat = new THREE.MeshStandardMaterial({ color: 0x3b82f6, roughness: 0.55 });
    const skinMat = new THREE.MeshStandardMaterial({ color: 0xe8be9e, roughness: 0.6 });

    const forearm = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.24, 6, 10), skinMat);
    forearm.rotation.x = Math.PI * 0.42;
    forearm.position.set(0, 0.04, -0.14);
    pivot.add(forearm);

    const sleeve = new THREE.Mesh(new THREE.CapsuleGeometry(0.052, 0.12, 6, 10), sleeveMat);
    sleeve.rotation.x = Math.PI * 0.42;
    sleeve.position.set(0, -0.02, -0.02);
    pivot.add(sleeve);

    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.032, 0.11), skinMat);
    hand.position.set(0, 0.09, -0.28);
    pivot.add(hand);

    this.fpArmPivot = pivot;
    this.camera.add(pivot);
  }

  public triggerFirstPersonSwing(dx: number, dy: number, speedPx: number): void {
    if (this.cameraViewMode !== 'first_person') return;
    const len = Math.max(1, Math.hypot(dx, dy));
    this.fpSwingDir.set(dx / len, dy / len);
    this.fpSwingDuration = THREE.MathUtils.clamp(0.34 - speedPx * 0.0001, 0.18, 0.34);
    this.fpSwingElapsed = 0;
  }

  public setFirstPersonBlock(blocking: boolean): void {
    this.fpBlocking = blocking;
  }

  public updateFirstPersonArm(dt: number): void {
    if (!this.fpArmPivot) return;
    const show = this.cameraViewMode === 'first_person' && !this.calibrateMode;
    this.fpArmPivot.visible = show;
    if (!show) return;

    if (this.fpSwingElapsed >= 0) {
      this.fpSwingElapsed += dt;
      const t = Math.min(1, this.fpSwingElapsed / this.fpSwingDuration);
      const swingCurve = Math.sin(t * Math.PI);
      const sx = this.fpSwingDir.x;
      const sy = this.fpSwingDir.y;

      this.fpArmPivot.position.set(
        0.26 + sx * swingCurve * 0.24,
        -0.24 - sy * swingCurve * 0.22,
        -0.34 - swingCurve * 0.2
      );
      this.fpArmPivot.rotation.set(
        -sy * swingCurve * 0.95,
        -sx * swingCurve * 1.15,
        -sx * swingCurve * 0.65
      );
      if (t >= 1) {
        this.fpSwingElapsed = -1;
      }
      return;
    }

    if (this.fpBlocking) {
      this.fpArmPivot.position.lerp(new THREE.Vector3(0.14, -0.06, -0.36), 1 - Math.exp(-dt * 14));
      this.fpArmPivot.rotation.set(0.65, 0.3, 0.2);
    } else {
      this.fpArmPivot.position.lerp(new THREE.Vector3(0.28, -0.26, -0.34), 1 - Math.exp(-dt * 10));
      this.fpArmPivot.rotation.set(0, 0, 0);
    }
  }

  public getFirstPersonHints(): FirstPersonHints {
    return {
      netEdge: { ...this.fpHints.netEdge },
      partnerEdge: { ...this.fpHints.partnerEdge },
    };
  }

  private projectEdgeIndicator(
    worldPos: THREE.Vector3,
    teamColor: string,
    wasVisible: boolean
  ): OffscreenLandingHint {
    const proj = worldPos.clone().project(this.camera);
    const behind = proj.z > 1;
    let nx = behind ? -proj.x : proj.x;
    let ny = behind ? -proj.y : proj.y;
    const threshold = wasVisible ? 0.64 : 0.78;
    const isOffCenter = behind || Math.abs(nx) > threshold || Math.abs(ny) > threshold;
    if (!isOffCenter) {
      return { visible: false, screenX: 0, screenY: 0, angleDeg: 0, teamColor };
    }
    const maxAxis = Math.max(Math.abs(nx), Math.abs(ny), 0.001);
    nx /= maxAxis;
    ny /= maxAxis;
    const pad = 38;
    const halfW = window.innerWidth * 0.5 - pad;
    const halfH = window.innerHeight * 0.5 - pad;
    const sx = window.innerWidth * 0.5 + nx * halfW;
    const sy = window.innerHeight * 0.5 - ny * halfH;
    const angleDeg = (Math.atan2(-ny, nx) * 180) / Math.PI;
    return { visible: true, screenX: sx, screenY: sy, angleDeg, teamColor };
  }

  private createNetDirectionArrow(): void {
    // 1. Dot on the net surface showing exact impact point
    const dotGeo = new THREE.CircleGeometry(0.06, 24);
    const dotMat = new THREE.MeshBasicMaterial({
      color: 0xfde047,
      transparent: true,
      opacity: 0.95,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.netHitDotMesh = new THREE.Mesh(dotGeo, dotMat);
    this.netHitDotMesh.rotation.x = -Math.PI / 2;
    this.netHitDotMesh.position.set(0, OFFICIAL_NET.netHeight + 0.024, 0);
    this.netHitDotMesh.visible = false;
    this.scene.add(this.netHitDotMesh);

    // 2. Exit arrow positioned OUTSIDE the rim pointing in the exact shoot-off direction
    const group = new THREE.Group();
    group.position.set(0, OFFICIAL_NET.netHeight + 0.03, 0);
    group.visible = false;

    const mat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.94,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    const outerStart = OFFICIAL_NET.rimRadius + 0.1;

    // Shaft outside the rim pointing along +Z
    const shaft = new THREE.Mesh(new THREE.PlaneGeometry(0.08, 0.28), mat);
    shaft.rotation.x = -Math.PI / 2;
    shaft.position.z = outerStart + 0.14;
    group.add(shaft);

    // Arrowhead outside the rim pointing along +Z
    const headShape = new THREE.Shape();
    headShape.moveTo(0, 0.18);
    headShape.lineTo(-0.13, -0.04);
    headShape.lineTo(0.13, -0.04);
    headShape.closePath();
    const head = new THREE.Mesh(new THREE.ShapeGeometry(headShape), mat);
    head.rotation.x = -Math.PI / 2;
    head.position.z = outerStart + 0.34;
    group.add(head);

    this.netArrowGroup = group;
    this.scene.add(group);
  }

  private createLandingCircle(): void {
    // Outer ring bigger than player foot+stamina ring (0.54 m -> outer landing circle 0.64..0.74 m)
    const outerGeo = new THREE.RingGeometry(0.64, 0.74, 40);
    this.landingRingMat = new THREE.MeshBasicMaterial({
      color: 0x3b82f6,
      transparent: true,
      opacity: 0.92,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const ring = new THREE.Mesh(outerGeo, this.landingRingMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.018;
    ring.renderOrder = 2;
    ring.visible = false;
    this.landingRingMesh = ring;
    this.scene.add(ring);

    // Dynamic inner height-indicator circle:
    // Same color as outside ring; smaller when ball is high, grows larger closer to ground, FULL (0.64 m) at hitting height!
    const innerGeo = new THREE.CircleGeometry(0.64, 36);
    this.landingInnerMat = new THREE.MeshBasicMaterial({
      color: 0x3b82f6,
      transparent: true,
      opacity: 0.65,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.landingInnerMesh = new THREE.Mesh(innerGeo, this.landingInnerMat);
    this.landingInnerMesh.rotation.x = -Math.PI / 2;
    this.landingInnerMesh.position.y = 0.017;
    this.landingInnerMesh.renderOrder = 2;
    this.landingInnerMesh.visible = false;
    this.scene.add(this.landingInnerMesh);
  }

  private createTimingRing(): void {
    const group = new THREE.Group();
    group.visible = false;
    group.renderOrder = 6;

    // Inner sweet-spot reference ring snugly around the ball
    this.timingTargetMat = new THREE.MeshBasicMaterial({
      color: 0x4ade80,
      transparent: true,
      opacity: 0.45,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: false,
    });
    this.timingTargetMesh = new THREE.Mesh(
      new THREE.RingGeometry(0.088, 0.106, 48),
      this.timingTargetMat
    );
    this.timingTargetMesh.renderOrder = 6;
    group.add(this.timingTargetMesh);

    // Outer shrinking approach ring around the ball
    this.timingOuterMat = new THREE.MeshBasicMaterial({
      color: 0xfacc15,
      transparent: true,
      opacity: 0.92,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: false,
    });
    this.timingOuterMesh = new THREE.Mesh(
      new THREE.RingGeometry(0.088, 0.114, 48),
      this.timingOuterMat
    );
    this.timingOuterMesh.renderOrder = 7;
    group.add(this.timingOuterMesh);

    this.timingRingGroup = group;
    this.scene.add(group);
  }

  public updateTimingRing(
    visible: boolean,
    ballPos: THREE.Vector3,
    ringProgress: number,
    zone: 'green' | 'yellow' | 'red'
  ): void {
    if (!visible || this.calibrateMode || this.isIntroSpinning()) {
      this.timingRingGroup.visible = false;
      return;
    }
    this.timingRingGroup.visible = true;
    this.timingRingGroup.position.copy(ballPos);
    this.timingRingGroup.quaternion.copy(this.camera.quaternion);

    const scale =
      ringProgress >= 0.5
        ? THREE.MathUtils.lerp(1.0, 2.55, (ringProgress - 0.5) * 2)
        : THREE.MathUtils.lerp(0.56, 1.0, ringProgress * 2);
    this.timingOuterMesh.scale.setScalar(scale);

    const hex = zone === 'green' ? 0x4ade80 : zone === 'yellow' ? 0xfacc15 : 0xf87171;
    this.timingOuterMat.color.setHex(hex);
    this.timingTargetMat.color.setHex(zone === 'green' ? 0x4ade80 : hex);
    this.timingTargetMat.opacity = zone === 'green' ? 0.9 : zone === 'yellow' ? 0.45 : 0.3;
  }

  public getBallScreenTarget(
    ballPos: THREE.Vector3
  ): { x: number; y: number; radiusPx: number } | null {
    const proj = ballPos.clone().project(this.camera);
    if (proj.z > 1) return null;
    const x = (proj.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-proj.y * 0.5 + 0.5) * window.innerHeight;
    const dist = this.camera.position.distanceTo(ballPos);
    const radiusPx = THREE.MathUtils.clamp(210 / Math.max(1.2, dist), 58, 102);
    return { x, y, radiusPx };
  }

  public getOffscreenLandingHint(): OffscreenLandingHint {
    return { ...this.offscreenLandingHint };
  }

  /**
   * Simulates the ball's forward trajectory using exact gravity, drag, and net trampoline bounce:
   * - Always shows the team-colored ground landing circle (bigger than player ring) + dynamic height inner circle.
   * - Only when `isAimedAfterHit` is true AND the ball is projected to hit the net/rim:
   *   shows a dot on the net impact spot and an exit arrow outside the rim.
   */
  public updateBallIndicators(
    ballPos: THREE.Vector3,
    ballVel: THREE.Vector3,
    isLive: boolean,
    isAimedAfterHit: boolean,
    activeTeamHex: number,
    activeTeamCss: string,
    partnerPos?: THREE.Vector3
  ): void {
    if (this.cameraViewMode === 'first_person' && !this.calibrateMode) {
      this.fpHints.netEdge = this.projectEdgeIndicator(
        new THREE.Vector3(0, 0.25, 0),
        '#facc15',
        this.fpHints.netEdge.visible
      );
      this.fpHints.partnerEdge = partnerPos
        ? this.projectEdgeIndicator(
            new THREE.Vector3(partnerPos.x, 1.35, partnerPos.z),
            '#60a5fa',
            this.fpHints.partnerEdge.visible
          )
        : { visible: false, screenX: 0, screenY: 0, angleDeg: 0, teamColor: '#60a5fa' };
    } else {
      this.fpHints.netEdge.visible = false;
      this.fpHints.partnerEdge.visible = false;
    }

    if (!isLive || ballPos.y <= OFFICIAL_BALL.radius + 0.01) {
      this.netHitDotMesh.visible = false;
      this.netArrowGroup.visible = false;
      this.landingRingMesh.visible = false;
      this.landingInnerMesh.visible = false;
      this.offscreenLandingHint.visible = false;
      return;
    }

    this.landingRingMat.color.setHex(activeTeamHex);
    this.landingInnerMat.color.setHex(activeTeamHex);

    const netPlaneY = OFFICIAL_NET.netHeight + OFFICIAL_BALL.radius;
    const netDiscRadius = OFFICIAL_NET.rimRadius + OFFICIAL_NET.rimTubeRadius * 0.5;
    const stepDt = 0.015;

    let x = ballPos.x;
    let y = ballPos.y;
    let z = ballPos.z;
    let vx = ballVel.x;
    let vy = ballVel.y;
    let vz = ballVel.z;

    let willHitNet = false;
    let netHitX = 0;
    let netHitZ = 0;
    let netOutVx = 0;
    let netOutVz = 0;
    let landed = false;

    for (let i = 0; i < 280; i++) {
      const prevX = x;
      const prevY = y;
      const prevZ = z;
      const prevVy = vy;

      const spd = Math.hypot(vx, vy, vz);
      if (spd > 0.05) {
        const drag = 1 - Math.min(0.18, OFFICIAL_BALL.airDrag * spd * stepDt);
        const lin = Math.exp(-OFFICIAL_BALL.linearDamping * stepDt);
        vx *= drag * lin;
        vy *= drag * lin;
        vz *= drag * lin;
      }
      vy += OFFICIAL_BALL.gravity * stepDt;
      x += vx * stepDt;
      y += vy * stepDt;
      z += vz * stepDt;

      // Check downward crossing of net plane
      if (!willHitNet && prevY >= netPlaneY && y <= netPlaneY && prevVy < -0.1) {
        const alpha = (netPlaneY - prevY) / Math.min(-0.0001, y - prevY);
        const hx = prevX + (x - prevX) * alpha;
        const hz = prevZ + (z - prevZ) * alpha;
        if (Math.hypot(hx, hz) <= netDiscRadius) {
          willHitNet = true;
          netHitX = hx;
          netHitZ = hz;
          const outVy = Math.max(2.6, Math.abs(vy) * OFFICIAL_NET.netRestitution);
          vx *= OFFICIAL_NET.netHorizontalDamping;
          vz *= OFFICIAL_NET.netHorizontalDamping;
          vy = outVy;
          netOutVx = vx;
          netOutVz = vz;
          x = hx;
          y = netPlaneY + 0.015;
          z = hz;
          continue;
        }
      }

      // Check ground impact
      if (y <= OFFICIAL_BALL.radius) {
        const alpha = (OFFICIAL_BALL.radius - prevY) / Math.min(-0.0001, y - prevY);
        x = prevX + (x - prevX) * alpha;
        z = prevZ + (z - prevZ) * alpha;
        landed = true;
        break;
      }
    }

    // Net dot & outside-rim exit arrow ONLY after someone hits it AND it is planned to hit the net/rim
    if (isAimedAfterHit && willHitNet) {
      this.netHitDotMesh.position.set(netHitX, OFFICIAL_NET.netHeight + 0.025, netHitZ);
      this.netHitDotMesh.visible = true;

      const outHoriz = Math.hypot(netOutVx, netOutVz);
      if (outHoriz > 0.25) {
        this.netArrowGroup.rotation.y = Math.atan2(netOutVx, netOutVz);
        const arrowScale = THREE.MathUtils.clamp(0.8 + outHoriz * 0.07, 0.8, 1.4);
        this.netArrowGroup.scale.set(1, 1, arrowScale);
        this.netArrowGroup.visible = true;
      } else {
        this.netArrowGroup.visible = false;
      }
    } else {
      this.netHitDotMesh.visible = false;
      this.netArrowGroup.visible = false;
    }

    // Always show ground landing spot whenever airborne
    if (landed || y < 12) {
      this.landingRingMesh.position.set(x, 0.018, z);
      this.landingRingMesh.visible = true;

      // Dynamic inner circle: small when high (> 1.98 m), grows larger closer to ground, FULL (1.0) at hitting height!
      const hitHeight = 1.98;
      const maxHeight = 4.2;
      let innerScale: number;
      if (ballPos.y <= hitHeight) {
        innerScale = 1.0;
        this.landingInnerMat.opacity = 0.78;
      } else {
        const heightNorm = THREE.MathUtils.clamp(
          (ballPos.y - hitHeight) / (maxHeight - hitHeight),
          0,
          1
        );
        innerScale = THREE.MathUtils.lerp(0.86, 0.18, heightNorm);
        this.landingInnerMat.opacity = 0.62;
      }
      this.landingInnerMesh.position.set(x, 0.017, z);
      this.landingInnerMesh.scale.setScalar(innerScale);
      this.landingInnerMesh.visible = true;

      const proj = this.landingRingMesh.position.clone().project(this.camera);
      const isOffscreen =
        proj.z > 1 || Math.abs(proj.x) > 0.9 || Math.abs(proj.y) > 0.9;
      if (isOffscreen) {
        let nx = proj.z > 1 ? -proj.x : proj.x;
        let ny = proj.z > 1 ? -proj.y : proj.y;
        const maxAxis = Math.max(Math.abs(nx), Math.abs(ny), 0.001);
        nx /= maxAxis;
        ny /= maxAxis;
        const pad = 42;
        const halfW = window.innerWidth * 0.5 - pad;
        const halfH = window.innerHeight * 0.5 - pad;
        const sx = window.innerWidth * 0.5 + nx * halfW;
        const sy = window.innerHeight * 0.5 - ny * halfH;
        const angleDeg = (Math.atan2(-ny, nx) * 180) / Math.PI;
        this.offscreenLandingHint = {
          visible: true,
          screenX: sx,
          screenY: sy,
          angleDeg,
          teamColor: activeTeamCss,
        };
      } else {
        this.offscreenLandingHint.visible = false;
      }
    } else {
      this.landingRingMesh.visible = false;
      this.landingInnerMesh.visible = false;
      this.offscreenLandingHint.visible = false;
    }
  }

  public startIntroSpin(style?: IntroCameraStyle): void {
    if (this.calibrateMode) return;
    if (style) this.introStyle = style;
    const durations: Record<IntroCameraStyle, number> = {
      swoop90: 4.2,
      wide_zoom_tilt: 4.2,
      glide180: 4.8,
      low_flyover: 4.0,
    };
    this.introSpinDuration = durations[this.introStyle];
    this.introSpinElapsed = 0;
    this.fpInit = false;
  }

  public setIntroStyle(style: IntroCameraStyle): void {
    this.introStyle = style;
  }

  public skipIntroSpin(): void {
    this.introSpinElapsed = -1;
  }

  public isIntroSpinning(): boolean {
    return this.introSpinElapsed >= 0 && this.introSpinElapsed < this.introSpinDuration;
  }

  public applySavedConfig(cfg: SavedCourtConfig): void {
    this.setCourtOffset(cfg.courtOffset);
    this.introStyle = cfg.introCameraStyle;
    this.serveCameras = cfg.serveCameras.map((c) => ({
      position: [...c.position] as [number, number, number],
      target: [...c.target] as [number, number, number],
    })) as [CameraPreset, CameraPreset, CameraPreset, CameraPreset];
    const preset = this.serveCameras[this.activeServeSlot] ?? this.serveCameras[0];
    this.baseCamPos.set(...preset.position);
    this.baseCamTarget.set(...preset.target);
    if (this.calibrateMode && this.calibrateTab === 'camera') {
      const calPreset = this.serveCameras[this.calibrateServeSlot];
      this.camera.position.set(...calPreset.position);
      this.orbitControls.target.set(...calPreset.target);
      this.orbitControls.update();
    }
  }

  public setActiveServeCamera(slotIndex: number): void {
    const idx = ((slotIndex % 4) + 4) % 4;
    if (idx === this.activeServeSlot) return;
    this.activeServeSlot = idx;
    const preset = this.serveCameras[idx];
    this.baseCamPos.set(...preset.position);
    this.baseCamTarget.set(...preset.target);
  }

  public setCalibrateServeSlot(slotIndex: number): void {
    // Save current slot before switching
    if (this.calibrateMode && this.calibrateTab === 'camera') {
      this.captureCurrentCameraIntoSlot(this.calibrateServeSlot);
    }
    this.calibrateServeSlot = ((slotIndex % 4) + 4) % 4;
    const preset = this.serveCameras[this.calibrateServeSlot];
    this.camera.position.set(...preset.position);
    this.orbitControls.target.set(...preset.target);
    this.camera.lookAt(this.orbitControls.target);
    this.orbitControls.update();
  }

  public setCameraPresetChangedCallback(cb: () => void): void {
    this.onCameraPresetChanged = cb;
  }

  private captureCurrentCameraIntoSlot(slotIndex: number): void {
    const round = (n: number) => Math.round(n * 1000) / 1000;
    const p = this.camera.position;
    const t = this.orbitControls.target;
    this.serveCameras[slotIndex] = {
      position: [round(p.x), round(p.y), round(p.z)],
      target: [round(t.x), round(t.y), round(t.z)],
    };
    if (slotIndex === this.activeServeSlot) {
      this.baseCamPos.copy(p);
      this.baseCamTarget.copy(t);
    }
  }

  private onOrbitEnd = (): void => {
    if (!this.calibrateMode || this.calibrateTab !== 'camera') return;
    this.captureCurrentCameraIntoSlot(this.calibrateServeSlot);
    this.onCameraPresetChanged?.();
  };

  public getSavedConfig(physicsSpeed: number, playerSpeed: number): SavedCourtConfig {
    if (this.calibrateMode && this.calibrateTab === 'camera') {
      this.captureCurrentCameraIntoSlot(this.calibrateServeSlot);
    }
    const round = (n: number) => Math.round(n * 1000) / 1000;
    return {
      courtOffset: {
        position: this.courtOffset.position.map(round) as [number, number, number],
        rotationY: round(this.courtOffset.rotationY),
        scale: round(this.courtOffset.scale),
      },
      serveCameras: this.serveCameras.map((c) => ({
        position: c.position.map(round) as [number, number, number],
        target: c.target.map(round) as [number, number, number],
      })) as [CameraPreset, CameraPreset, CameraPreset, CameraPreset],
      physicsSpeed: round(physicsSpeed),
      playerSpeed: round(playerSpeed),
      introCameraStyle: this.introStyle,
    };
  }

  public setCameraViewMode(mode: 'pressbox' | 'first_person'): void {
    this.cameraViewMode = mode;
    this.fpInit = false;
    this.skipIntroSpin();
  }

  public resetFirstPersonCamera(): void {
    this.fpInit = false;
  }

  public getCameraViewMode(): 'pressbox' | 'first_person' {
    return this.cameraViewMode;
  }

  public setCalibrateMode(enabled: boolean): void {
    this.calibrateMode = enabled;
    this.fpInit = false;
    this.skipIntroSpin();
    this.netPointers.clear();
    this.netPrevPinchDist = 0;
    this.orbitControls.enabled = enabled && this.calibrateTab === 'camera';
    if (enabled) {
      const preset = this.serveCameras[this.calibrateServeSlot];
      this.camera.position.set(...preset.position);
      this.orbitControls.target.set(...preset.target);
      this.orbitControls.update();
    } else {
      this.captureCurrentCameraIntoSlot(this.calibrateServeSlot);
      const activePreset = this.serveCameras[this.activeServeSlot];
      this.baseCamPos.set(...activePreset.position);
      this.baseCamTarget.set(...activePreset.target);
      this.currentCamPos.copy(this.baseCamPos);
      this.currentCamTarget.copy(this.baseCamTarget);
      this.currentZoomFactor = 1.0;
    }
  }

  public setCalibrateTab(tab: 'camera' | 'net'): void {
    this.calibrateTab = tab;
    this.netPointers.clear();
    this.netPrevPinchDist = 0;
    this.orbitControls.enabled = this.calibrateMode && tab === 'camera';
  }

  public setCourtOffsetSyncCallback(cb: (offset: CourtOffsetConfig) => void): void {
    this.onCourtOffsetSync = cb;
  }

  private onNetCalPointerDown = (e: PointerEvent): void => {
    if (!this.calibrateMode || this.calibrateTab !== 'net') return;
    this.netPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.netPointers.size === 2) {
      const pts = Array.from(this.netPointers.values());
      this.netPrevPinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    }
  };

  private onNetCalPointerMove = (e: PointerEvent): void => {
    if (!this.calibrateMode || this.calibrateTab !== 'net') return;
    const prev = this.netPointers.get(e.pointerId);
    if (!prev) return;

    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    this.netPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.netPointers.size === 1) {
      // Drag to set horizontal placement (X / Z) relative to camera view
      const camForward = new THREE.Vector3();
      this.camera.getWorldDirection(camForward);
      camForward.y = 0;
      if (camForward.lengthSq() > 0.0001) camForward.normalize();
      const camRight = new THREE.Vector3().crossVectors(camForward, new THREE.Vector3(0, 1, 0)).normalize();

      const camDist = this.camera.position.distanceTo(this.orbitControls.target);
      const sensitivity = camDist * 0.0014;
      const moveVec = new THREE.Vector3()
        .addScaledVector(camRight, dx * sensitivity)
        .addScaledVector(camForward, -dy * sensitivity);

      this.courtOffset.position[0] += moveVec.x;
      this.courtOffset.position[2] += moveVec.z;
      this.applyCourtOffset();
      this.onCourtOffsetSync?.(this.getCourtOffset());
    } else if (this.netPointers.size === 2) {
      // Pinch to set scale
      const pts = Array.from(this.netPointers.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (this.netPrevPinchDist > 10) {
        const ratio = dist / this.netPrevPinchDist;
        this.courtOffset.scale = THREE.MathUtils.clamp(this.courtOffset.scale * ratio, 0.2, 3.0);
        this.applyCourtOffset();
        this.onCourtOffsetSync?.(this.getCourtOffset());
      }
      this.netPrevPinchDist = dist;
    }
  };

  private onNetCalPointerUp = (e: PointerEvent): void => {
    this.netPointers.delete(e.pointerId);
    if (this.netPointers.size < 2) {
      this.netPrevPinchDist = 0;
    }
  };

  private onNetCalWheel = (e: WheelEvent): void => {
    if (!this.calibrateMode || this.calibrateTab !== 'net') return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.04 : 0.96;
    this.courtOffset.scale = THREE.MathUtils.clamp(this.courtOffset.scale * factor, 0.2, 3.0);
    this.applyCourtOffset();
    this.onCourtOffsetSync?.(this.getCourtOffset());
  };

  public isCalibrateMode(): boolean {
    return this.calibrateMode;
  }

  public getCourtOffset(): CourtOffsetConfig {
    return {
      position: [...this.courtOffset.position],
      rotationY: this.courtOffset.rotationY,
      scale: this.courtOffset.scale,
    };
  }

  public setCourtOffset(offset: CourtOffsetConfig): void {
    this.courtOffset = {
      position: [...offset.position],
      rotationY: offset.rotationY,
      scale: offset.scale,
    };
    this.applyCourtOffset();
  }

  private applyCourtOffset(): void {
    this.courtGroup.position.set(...this.courtOffset.position);
    this.courtGroup.rotation.y = this.courtOffset.rotationY;
    this.courtGroup.scale.setScalar(this.courtOffset.scale);
    this.courtGroup.updateMatrixWorld(true);
  }

  public setFov(fov: number): void {
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  public getViewConfigJson(): string {
    const camPos = this.camera.position;
    const tgt = this.orbitControls.target;
    const round = (n: number) => Math.round(n * 1000) / 1000;
    return JSON.stringify(
      {
        cameraPosition: [round(camPos.x), round(camPos.y), round(camPos.z)],
        cameraTarget: [round(tgt.x), round(tgt.y), round(tgt.z)],
        fov: round(this.camera.fov),
        courtOffset: {
          position: this.courtOffset.position.map(round),
          rotationY: round(this.courtOffset.rotationY),
          scale: round(this.courtOffset.scale),
        },
      },
      null,
      2
    );
  }

  /**
   * Press-box camera:
   * - Starts at calibrated base view for the serve.
   * - Main focus on the net, blended gently with the ball, with subtle panning & rotation.
   * - Always keeps all 4 players + ball inside the frame; zooming out also pitches more downward.
   */
  public updateCamera(
    trackedPoints: THREE.Vector3[],
    ballPos: THREE.Vector3,
    humanPos: THREE.Vector3,
    dt: number
  ): void {
    if (this.calibrateMode) {
      this.orbitControls.update();
      return;
    }

    // Starting game cinematic camera intro animation
    if (this.introSpinElapsed >= 0) {
      this.introSpinElapsed += dt;
      const t = Math.min(1, this.introSpinElapsed / this.introSpinDuration);
      // Smooth quintic ease-in-out for natural, non-dizzy motion
      const ease = t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2;
      const easeOut = 1 - Math.pow(1 - t, 3);

      const baseOffset = this.baseCamPos.clone().sub(this.baseCamTarget);
      const desiredPos = new THREE.Vector3();
      const desiredTarget = this.baseCamTarget.clone();

      if (this.introStyle === 'wide_zoom_tilt') {
        // Wide establishing view -> smooth zoom into court -> gentle downward tilt onto net
        const zoomFactor = THREE.MathUtils.lerp(2.1, 1.0, ease);
        const sideAngle = THREE.MathUtils.lerp(0.28, 0, ease);
        const offset = baseOffset.clone().multiplyScalar(zoomFactor);
        offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), sideAngle);
        // Start slightly lower/wider horizon, then tilt downward as we settle
        offset.y *= THREE.MathUtils.lerp(0.78, 1.0, ease);
        desiredTarget.y = THREE.MathUtils.lerp(1.85, this.baseCamTarget.y, easeOut);
        desiredPos.copy(this.baseCamTarget).add(offset);
      } else if (this.introStyle === 'glide180') {
        // Slow, smooth 180° arc around the court showing off the Gaussian Splat
        const angle = (1 - ease) * Math.PI;
        const zoomFactor = THREE.MathUtils.lerp(1.25, 1.0, ease);
        const offset = baseOffset.clone().multiplyScalar(zoomFactor);
        offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), angle);
        offset.y += Math.sin(t * Math.PI) * 1.1;
        desiredPos.copy(this.baseCamTarget).add(offset);
      } else if (this.introStyle === 'low_flyover') {
        // Low grass-level skim swooping up into press-box view
        const angle = (1 - ease) * (Math.PI * 0.35);
        const zoomFactor = THREE.MathUtils.lerp(1.42, 1.0, easeOut);
        const offset = baseOffset.clone().multiplyScalar(zoomFactor);
        offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), angle);
        offset.y = THREE.MathUtils.lerp(1.65, baseOffset.y, ease);
        desiredTarget.y = THREE.MathUtils.lerp(1.05, this.baseCamTarget.y, ease);
        desiredPos.copy(this.baseCamTarget).add(offset);
      } else {
        // 'swoop90' (default): Natural 90° swoop-in from a wider side angle
        const angle = (1 - ease) * (Math.PI * 0.5);
        const zoomFactor = THREE.MathUtils.lerp(1.38, 1.0, easeOut);
        const offset = baseOffset.clone().multiplyScalar(zoomFactor);
        offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), angle);
        offset.y = THREE.MathUtils.lerp(baseOffset.y * 0.72, baseOffset.y, ease);
        desiredTarget.y = THREE.MathUtils.lerp(1.15, this.baseCamTarget.y, easeOut);
        desiredPos.copy(this.baseCamTarget).add(offset);
      }

      this.currentCamPos.copy(desiredPos);
      this.currentCamTarget.copy(desiredTarget);
      this.camera.position.copy(this.currentCamPos);
      this.camera.lookAt(this.currentCamTarget);
      if (t >= 1) {
        this.introSpinElapsed = -1;
      }
      return;
    }

    if (this.cameraViewMode === 'first_person') {
      const lookVec = ballPos.clone().sub(new THREE.Vector3(humanPos.x, 1.66, humanPos.z));
      const horizLook = new THREE.Vector3(lookVec.x, 0, lookVec.z);
      if (horizLook.lengthSq() < 0.04) {
        // Fallback toward net if ball is directly overhead/at eye center
        horizLook.set(-humanPos.x, 0, -humanPos.z);
      }
      if (horizLook.lengthSq() > 0.0001) {
        horizLook.normalize();
      } else {
        horizLook.set(0, 0, -1);
      }

      const desiredEye = new THREE.Vector3(humanPos.x, 1.66, humanPos.z).addScaledVector(
        horizLook,
        0.16
      );
      const aimVec = ballPos.clone().sub(desiredEye);
      const horizDist = Math.max(0.25, Math.hypot(aimVec.x, aimVec.z));
      const desiredYaw = Math.atan2(aimVec.x, aimVec.z);
      const desiredPitch = THREE.MathUtils.clamp(Math.atan2(aimVec.y, horizDist), -1.05, 0.92);

      if (!this.fpInit) {
        this.fpEyePos.copy(desiredEye);
        this.fpEyeVelX.v = 0;
        this.fpEyeVelY.v = 0;
        this.fpEyeVelZ.v = 0;
        this.fpYaw = desiredYaw;
        this.fpYawVel.v = 0;
        this.fpPitch = desiredPitch;
        this.fpPitchVel.v = 0;
        this.fpInit = true;
      } else {
        const clampedDt = Math.min(dt, 0.05);
        this.fpEyePos.x = smoothDampScalar(
          this.fpEyePos.x,
          desiredEye.x,
          this.fpEyeVelX,
          0.13,
          clampedDt
        );
        this.fpEyePos.y = smoothDampScalar(
          this.fpEyePos.y,
          desiredEye.y,
          this.fpEyeVelY,
          0.14,
          clampedDt
        );
        this.fpEyePos.z = smoothDampScalar(
          this.fpEyePos.z,
          desiredEye.z,
          this.fpEyeVelZ,
          0.13,
          clampedDt
        );
        this.fpYaw = smoothDampAngle(this.fpYaw, desiredYaw, this.fpYawVel, 0.15, clampedDt);
        this.fpPitch = smoothDampScalar(
          this.fpPitch,
          desiredPitch,
          this.fpPitchVel,
          0.17,
          clampedDt
        );
      }

      const cosP = Math.cos(this.fpPitch);
      const lookDir = new THREE.Vector3(
        Math.sin(this.fpYaw) * cosP,
        Math.sin(this.fpPitch),
        Math.cos(this.fpYaw) * cosP
      );
      this.currentCamPos.copy(this.fpEyePos);
      this.currentCamTarget.copy(this.fpEyePos).add(lookDir);
      this.camera.position.copy(this.currentCamPos);
      this.camera.lookAt(this.currentCamTarget);
      return;
    }

    let maxEdge = 0;
    const proj = new THREE.Vector3();
    for (const p of trackedPoints) {
      proj.copy(p).project(this.camera);
      maxEdge = Math.max(maxEdge, Math.abs(proj.x), Math.abs(proj.y));
    }
    if (this.landingRingMesh.visible) {
      proj.copy(this.landingRingMesh.position).project(this.camera);
      maxEdge = Math.max(maxEdge, Math.abs(proj.x), Math.abs(proj.y));
    }

    let targetZoom = 1.0;
    if (maxEdge > 0.72) {
      targetZoom = Math.min(2.25, 1.0 + (maxEdge - 0.72) * 2.1);
    }

    // Zoom out quickly for fast chases, ease back in smoothly
    const zoomRate =
      targetZoom > this.currentZoomFactor
        ? 1 - Math.exp(-dt * 6.5)
        : 1 - Math.exp(-dt * 2.8);
    this.currentZoomFactor += (targetZoom - this.currentZoomFactor) * zoomRate;

    const lerpRate = 1 - Math.exp(-dt * 4.2);

    // Main focus on the net, blended gently toward the ball
    const desiredTarget = this.baseCamTarget
      .clone()
      .lerp(new THREE.Vector3(ballPos.x, Math.max(0.35, ballPos.y * 0.45), ballPos.z), 0.28);

    // Subtle panning & yaw rotation around the net following play, plus downward pitch when zoomed out
    const baseOffset = this.baseCamPos
      .clone()
      .sub(this.baseCamTarget)
      .multiplyScalar(this.currentZoomFactor);
    const yawAngle = THREE.MathUtils.clamp(ballPos.x * 0.032, -0.22, 0.22);
    baseOffset.applyAxisAngle(new THREE.Vector3(0, 1, 0), yawAngle);

    // Moving out rotates more down-looking (extra Y elevation)
    const extraDownLookY = Math.max(0, this.currentZoomFactor - 1.0) * 3.8;

    const desiredPos = this.baseCamTarget
      .clone()
      .add(baseOffset)
      .add(new THREE.Vector3(ballPos.x * 0.22, extraDownLookY, ballPos.z * 0.14));

    this.currentCamTarget.lerp(desiredTarget, lerpRate);
    this.currentCamPos.lerp(desiredPos, lerpRate);

    this.camera.position.copy(this.currentCamPos);
    this.camera.lookAt(this.currentCamTarget);
  }

  public render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  private handleResize = (): void => {
    const parent = this.renderer.domElement.parentElement;
    const w = parent?.clientWidth || window.innerWidth;
    const h = parent?.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };

  public dispose(): void {
    window.removeEventListener('resize', this.handleResize);
    const dom = this.renderer.domElement;
    dom.removeEventListener('pointerdown', this.onNetCalPointerDown);
    window.removeEventListener('pointermove', this.onNetCalPointerMove);
    window.removeEventListener('pointerup', this.onNetCalPointerUp);
    window.removeEventListener('pointercancel', this.onNetCalPointerUp);
    dom.removeEventListener('wheel', this.onNetCalWheel);
    this.orbitControls.removeEventListener('end', this.onOrbitEnd);
    this.orbitControls.dispose();
    this.renderer.dispose();
  }
}
