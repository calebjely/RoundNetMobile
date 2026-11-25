import * as THREE from 'three';

export interface SwipeEvent {
  dx: number;
  dy: number;
  distancePx: number;
  speedPxPerSec: number;
  startX: number;
  startY: number;
  isTap?: boolean;
}

export interface JoystickVisualState {
  active: boolean;
  originX: number;
  originY: number;
  thumbX: number;
  thumbY: number;
  deflection: number; // 0..1
  isSprint: boolean;
}

export interface SwipeVisualState {
  active: boolean;
  startX: number;
  startY: number;
  curX: number;
  curY: number;
  onBall: boolean;
  inRange: boolean;
}

export interface SwipeTarget {
  x: number;
  y: number;
  radiusPx: number;
  inRange: boolean;
  allowAnywhere?: boolean;
}

export interface InputCallbacks {
  onSwipe: (swipe: SwipeEvent) => void;
  onBlockStart: () => void;
  onBlockEnd: () => void;
  onReturnToNetCancel: () => void;
}

export class InputManager {
  private readonly element: HTMLElement;
  private readonly callbacks: InputCallbacks;

  // Left Zone (Virtual Joystick)
  private leftPointerId: number | null = null;
  private readonly maxRadiusPx = 68;
  public joystickState: JoystickVisualState = {
    active: false,
    originX: 0,
    originY: 0,
    thumbX: 0,
    thumbY: 0,
    deflection: 0,
    isSprint: false,
  };
  public moveVector = new THREE.Vector2(0, 0);

  // Right Zone (Swipe & Tap-Hold Block)
  private rightPointerId: number | null = null;
  private rightStartX = 0;
  private rightStartY = 0;
  private rightStartTime = 0;
  private rightMaxDist = 0;
  private swipeSamples: { x: number; y: number; t: number }[] = [];
  private swipeFired = false;
  private startedOnBall = false;
  private blockHoldTimer: number | null = null;
  private isHoldingBlock = false;
  public getSwipeTarget: (() => SwipeTarget | null) | null = null;
  public swipeVisual: SwipeVisualState = {
    active: false,
    startX: 0,
    startY: 0,
    curX: 0,
    curY: 0,
    onBall: false,
    inRange: false,
  };

  // Desktop keyboard fallback
  private keys = new Set<string>();
  public enabled = true;
  /** When true (1st-person auto-runner), swiping anywhere on screen triggers hits */
  public fullScreenSwipe = true;

  constructor(element: HTMLElement, callbacks: InputCallbacks) {
    this.element = element;
    this.callbacks = callbacks;

    this.element.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (!this.enabled) return;
    // Ignore clicks on UI buttons/drawers
    const target = e.target as HTMLElement | null;
    if (target && target.closest('[data-ui-interactive="true"]')) {
      return;
    }

    const halfW = window.innerWidth * 0.5;
    if (!this.fullScreenSwipe && e.clientX < halfW && this.leftPointerId === null) {
      this.leftPointerId = e.pointerId;
      this.callbacks.onReturnToNetCancel();
      // If user touches inside the persistent bottom-left joystick area, anchor to it; otherwise dynamic origin
      const persistEl = document.getElementById('persistent-joystick-base');
      let ox = e.clientX;
      let oy = e.clientY;
      if (persistEl) {
        const rect = persistEl.getBoundingClientRect();
        const cx = rect.left + rect.width * 0.5;
        const cy = rect.top + rect.height * 0.5;
        if (Math.hypot(e.clientX - cx, e.clientY - cy) <= this.maxRadiusPx * 1.45) {
          ox = cx;
          oy = cy;
        }
      }
      this.joystickState = {
        active: true,
        originX: ox,
        originY: oy,
        thumbX: e.clientX,
        thumbY: e.clientY,
        deflection: 0,
        isSprint: false,
      };
      this.updateLeftThumb(e.clientX, e.clientY);
    } else if ((this.fullScreenSwipe || e.clientX >= halfW) && this.rightPointerId === null) {
      const now = performance.now();
      this.rightPointerId = e.pointerId;
      this.rightStartX = e.clientX;
      this.rightStartY = e.clientY;
      this.rightStartTime = now;
      this.rightMaxDist = 0;
      this.swipeFired = false;
      this.swipeSamples = [{ x: e.clientX, y: e.clientY, t: now }];
      const target = this.getSwipeTarget?.() ?? null;
      this.startedOnBall =
        target !== null &&
        Math.hypot(e.clientX - target.x, e.clientY - target.y) <= target.radiusPx;
      this.swipeVisual = {
        active: this.startedOnBall,
        startX: e.clientX,
        startY: e.clientY,
        curX: e.clientX,
        curY: e.clientY,
        onBall: this.startedOnBall,
        inRange: target?.inRange ?? false,
      };

      // Tap & Hold to Block after 130ms if finger hasn't swiped far
      this.blockHoldTimer = window.setTimeout(() => {
        if (this.rightPointerId !== null && this.rightMaxDist < 28 && !this.swipeFired) {
          this.isHoldingBlock = true;
          this.callbacks.onBlockStart();
        }
      }, 130);
    }
  };

  private updateLeftThumb(clientX: number, clientY: number): void {
    const dx = clientX - this.joystickState.originX;
    const dy = clientY - this.joystickState.originY;
    const dist = Math.hypot(dx, dy);
    const clamped = Math.min(dist, this.maxRadiusPx);
    const angle = Math.atan2(dy, dx);

    this.joystickState.thumbX = this.joystickState.originX + Math.cos(angle) * clamped;
    this.joystickState.thumbY = this.joystickState.originY + Math.sin(angle) * clamped;
    this.joystickState.deflection = clamped / this.maxRadiusPx;
    this.joystickState.isSprint = this.joystickState.deflection > 0.55;

    if (dist > 4) {
      this.moveVector.set(Math.cos(angle), Math.sin(angle));
    } else {
      this.moveVector.set(0, 0);
    }
  }

  private emitBufferedSwipe(now: number, curX: number, curY: number): boolean {
    let anchor = this.swipeSamples[0] ?? {
      x: this.rightStartX,
      y: this.rightStartY,
      t: this.rightStartTime,
    };
    for (let i = 0; i < this.swipeSamples.length; i++) {
      if (now - this.swipeSamples[i].t <= 140) {
        anchor = this.swipeSamples[i];
        break;
      }
    }
    const dx = curX - anchor.x;
    const dy = curY - anchor.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 16) return false;
    const elapsedSec = Math.max(0.035, (now - anchor.t) / 1000);
    this.swipeFired = true;
    if (this.blockHoldTimer !== null) {
      clearTimeout(this.blockHoldTimer);
      this.blockHoldTimer = null;
    }
    this.callbacks.onSwipe({
      dx,
      dy,
      distancePx: dist,
      speedPxPerSec: dist / elapsedSec,
      startX: anchor.x,
      startY: anchor.y,
    });
    return true;
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (e.pointerId === this.leftPointerId) {
      this.updateLeftThumb(e.clientX, e.clientY);
    } else if (e.pointerId === this.rightPointerId) {
      const now = performance.now();
      this.swipeSamples.push({ x: e.clientX, y: e.clientY, t: now });
      while (this.swipeSamples.length > 1 && now - this.swipeSamples[0].t > 300) {
        this.swipeSamples.shift();
      }

      const distFromStart = Math.hypot(e.clientX - this.rightStartX, e.clientY - this.rightStartY);
      this.rightMaxDist = Math.max(this.rightMaxDist, distFromStart);
      if (this.rightMaxDist > 30 && this.isHoldingBlock) {
        this.isHoldingBlock = false;
        this.callbacks.onBlockEnd();
      }

      if (!this.swipeFired && !this.isHoldingBlock) {
        const target = this.getSwipeTarget?.() ?? null;
        if (this.swipeVisual.active) {
          this.swipeVisual.curX = e.clientX;
          this.swipeVisual.curY = e.clientY;
          this.swipeVisual.inRange = target?.inRange ?? false;
        }
        if (target && !target.allowAnywhere) {
          // Must touch the ball within its timing circle at the start of the swipe
          if (this.startedOnBall && target.inRange && distFromStart >= 32) {
            this.swipeVisual.active = false;
            this.emitBufferedSwipe(now, e.clientX, e.clientY);
          }
        } else if (distFromStart >= 55) {
          this.swipeVisual.active = false;
          this.emitBufferedSwipe(now, e.clientX, e.clientY);
        }
      }
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId === this.leftPointerId) {
      this.leftPointerId = null;
      this.joystickState.active = false;
      this.joystickState.deflection = 0;
      this.joystickState.isSprint = false;
      this.moveVector.set(0, 0);
    } else if (e.pointerId === this.rightPointerId) {
      if (this.blockHoldTimer !== null) {
        clearTimeout(this.blockHoldTimer);
        this.blockHoldTimer = null;
      }

      this.swipeVisual.active = false;
      if (this.isHoldingBlock) {
        this.isHoldingBlock = false;
        this.callbacks.onBlockEnd();
      } else if (!this.swipeFired) {
        const target = this.getSwipeTarget?.() ?? null;
        const distFromStart = Math.hypot(e.clientX - this.rightStartX, e.clientY - this.rightStartY);
        if (this.startedOnBall && target?.inRange && distFromStart < 24) {
          this.swipeFired = true;
          this.callbacks.onSwipe({
            dx: 0,
            dy: 0,
            distancePx: 0,
            speedPxPerSec: 180,
            startX: this.rightStartX,
            startY: this.rightStartY,
            isTap: true,
          });
        } else {
          const canFireOnRelease =
            !target || target.allowAnywhere || (this.startedOnBall && target.inRange);
          if (canFireOnRelease) {
            const now = performance.now();
            this.swipeSamples.push({ x: e.clientX, y: e.clientY, t: now });
            this.emitBufferedSwipe(now, e.clientX, e.clientY);
          }
        }
      }
      this.startedOnBall = false;
      this.swipeSamples = [];
      this.rightPointerId = null;
    }
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    this.keys.add(e.code);
    if (e.code === 'Space' && !e.repeat) {
      this.callbacks.onSwipe({
        dx: 0,
        dy: -110,
        distancePx: 110,
        speedPxPerSec: 950,
        startX: window.innerWidth * 0.75,
        startY: window.innerHeight * 0.65,
      });
    }
    if (e.code === 'KeyB' && !e.repeat) {
      this.isHoldingBlock = true;
      this.callbacks.onBlockStart();
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
    if (e.code === 'KeyB' && this.isHoldingBlock) {
      this.isHoldingBlock = false;
      this.callbacks.onBlockEnd();
    }
  };

  public getMoveIntent(): { dir: THREE.Vector2; deflection: number } {
    if (this.joystickState.active) {
      return { dir: this.moveVector.clone(), deflection: this.joystickState.deflection };
    }

    // Keyboard fallback
    let kx = 0;
    let kz = 0;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) kx -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) kx += 1;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) kz -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) kz += 1;
    if (kx !== 0 || kz !== 0) {
      const dir = new THREE.Vector2(kx, kz).normalize();
      const sprinting = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
      return { dir, deflection: sprinting ? 0.92 : 0.48 };
    }

    return { dir: new THREE.Vector2(0, 0), deflection: 0 };
  }

  public dispose(): void {
    this.element.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
  }
}
