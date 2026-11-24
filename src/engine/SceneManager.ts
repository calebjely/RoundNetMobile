import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { OFFICIAL_BALL, OFFICIAL_NET } from '../config/equipment';
import { IRF_2026_RULES } from '../config/rules';
import { CourtOffsetConfig, MapConfig } from '../config/maps';

export interface SceneLoadResult {
  splatLoaded: boolean;
  collisionRoot: THREE.Object3D | null;
  usingProceduralFallback: boolean;
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
  private calibrateMode = false;
  private calibrateTab: 'camera' | 'net' = 'camera';
  private netPointers = new Map<number, { x: number; y: number }>();
  private netPrevPinchDist = 0;
  private onCourtOffsetSync?: (offset: CourtOffsetConfig) => void;

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

  private netArrowGroup!: THREE.Group;
  private landingRingMesh!: THREE.Mesh;

  private proceduralEnvGroup: THREE.Group | null = null;
  private readonly gltfLoader = new GLTFLoader();

  constructor(container: HTMLElement, mapConfig: MapConfig) {
    this.mapConfig = mapConfig;
    this.courtOffset = {
      position: [...mapConfig.courtOffset.position],
      rotationY: mapConfig.courtOffset.rotationY,
      scale: mapConfig.courtOffset.scale,
    };

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x9ec5e8);
    this.scene.fog = new THREE.Fog(0x9ec5e8, 28, 70);

    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;

    this.camera = new THREE.PerspectiveCamera(mapConfig.fov, width / height, 0.1, 150);
    this.baseCamPos = new THREE.Vector3(...mapConfig.cameraPosition);
    this.baseCamTarget = new THREE.Vector3(...mapConfig.cameraTarget);
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
    this.ballMesh = this.createOfficialBall();
    this.scene.add(this.ballMesh);

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
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 0.01;
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
    });
    for (let i = 0; i < 4; i++) {
      const angle = Math.PI / 4 + (i * Math.PI) / 2;
      const line = new THREE.Mesh(lineGeo, lineMat);
      line.rotation.x = -Math.PI / 2;
      line.rotation.z = -angle;
      line.position.set(Math.sin(angle) * midR, 0.01, Math.cos(angle) * midR);
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
      normalMap,
      normalScale: new THREE.Vector2(0.75, 0.75),
      roughness: 0.42,
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

  private createNetDirectionArrow(): void {
    const group = new THREE.Group();
    group.position.set(0, OFFICIAL_NET.netHeight + 0.035, 0);
    group.visible = false;

    const mat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    // Shaft pointing along +Z
    const shaft = new THREE.Mesh(new THREE.PlaneGeometry(0.08, 0.34), mat);
    shaft.rotation.x = -Math.PI / 2;
    shaft.position.z = 0.08;
    group.add(shaft);

    // Arrowhead cone/triangle pointing along +Z
    const headShape = new THREE.Shape();
    headShape.moveTo(0, 0.16);
    headShape.lineTo(-0.12, -0.06);
    headShape.lineTo(0.12, -0.06);
    headShape.closePath();
    const head = new THREE.Mesh(new THREE.ShapeGeometry(headShape), mat);
    head.rotation.x = -Math.PI / 2;
    head.position.z = 0.3;
    group.add(head);

    this.netArrowGroup = group;
    this.scene.add(group);
  }

  private createLandingCircle(): void {
    const geo = new THREE.RingGeometry(0.16, 0.25, 32);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xfacc15,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(geo, mat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.016;
    ring.visible = false;
    this.landingRingMesh = ring;
    this.scene.add(ring);
  }

  public updateBallIndicators(
    ballPos: THREE.Vector3,
    ballVel: THREE.Vector3,
    isLive: boolean
  ): void {
    if (!isLive) {
      this.netArrowGroup.visible = false;
      this.landingRingMesh.visible = false;
      return;
    }

    const horizSpeed = Math.hypot(ballVel.x, ballVel.z);
    if (horizSpeed > 0.35) {
      this.netArrowGroup.visible = true;
      this.netArrowGroup.rotation.y = Math.atan2(ballVel.x, ballVel.z);
      const scale = THREE.MathUtils.clamp(0.75 + horizSpeed * 0.08, 0.75, 1.45);
      this.netArrowGroup.scale.set(1, 1, scale);
    } else {
      this.netArrowGroup.visible = false;
    }

    // Predict ground landing point (y = OFFICIAL_BALL.radius)
    const y0 = ballPos.y;
    const r = OFFICIAL_BALL.radius;
    const g = OFFICIAL_BALL.gravity; // negative
    if (y0 > r + 0.02) {
      const a = 0.5 * g;
      const b = ballVel.y;
      const c = y0 - r;
      const disc = b * b - 4 * a * c;
      if (disc >= 0) {
        const t = (-b - Math.sqrt(disc)) / (2 * a);
        if (t > 0 && t < 5) {
          const dragAtten = Math.exp(-OFFICIAL_BALL.linearDamping * t * 0.5);
          const landX = ballPos.x + ballVel.x * t * dragAtten;
          const landZ = ballPos.z + ballVel.z * t * dragAtten;
          this.landingRingMesh.position.set(landX, 0.016, landZ);
          this.landingRingMesh.visible = true;
          return;
        }
      }
    }
    this.landingRingMesh.visible = false;
  }

  public setCalibrateMode(enabled: boolean): void {
    this.calibrateMode = enabled;
    this.netPointers.clear();
    this.netPrevPinchDist = 0;
    this.orbitControls.enabled = enabled && this.calibrateTab === 'camera';
    if (!enabled) {
      // Keep calibrated camera for immediate playtesting
      this.baseCamPos.copy(this.camera.position);
      this.baseCamTarget.copy(this.orbitControls.target);
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
   * Press-box camera with main focus on the net, blended with the ball,
   * subtle panning & rotation, and Dynamic Zoom Guard.
   */
  public updateCamera(
    trackedPoints: THREE.Vector3[],
    ballPos: THREE.Vector3,
    dt: number
  ): void {
    if (this.calibrateMode) {
      this.orbitControls.update();
      return;
    }

    let maxEdge = 0;
    const proj = new THREE.Vector3();
    for (const p of trackedPoints) {
      proj.copy(p).project(this.camera);
      maxEdge = Math.max(maxEdge, Math.abs(proj.x), Math.abs(proj.y));
    }

    let targetZoom = 1.0;
    if (maxEdge > 0.78) {
      targetZoom = Math.min(this.mapConfig.maxZoomOutFactor, 1.0 + (maxEdge - 0.78) * 1.35);
    }

    const lerpRate = 1 - Math.exp(-dt * 3.8);
    this.currentZoomFactor += (targetZoom - this.currentZoomFactor) * lerpRate;

    // Main focus on the net, blended gently toward the ball
    const desiredTarget = this.baseCamTarget
      .clone()
      .lerp(new THREE.Vector3(ballPos.x, Math.max(0.35, ballPos.y * 0.5), ballPos.z), 0.3);

    // Subtle panning & yaw rotation around the net following play
    const baseOffset = this.baseCamPos.clone().sub(this.baseCamTarget).multiplyScalar(this.currentZoomFactor);
    const yawAngle = THREE.MathUtils.clamp(ballPos.x * 0.032, -0.22, 0.22);
    baseOffset.applyAxisAngle(new THREE.Vector3(0, 1, 0), yawAngle);

    const desiredPos = this.baseCamTarget
      .clone()
      .add(baseOffset)
      .add(new THREE.Vector3(ballPos.x * 0.22, 0, ballPos.z * 0.14));

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
    this.orbitControls.dispose();
    this.renderer.dispose();
  }
}
