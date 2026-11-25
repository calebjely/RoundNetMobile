import * as THREE from 'three';

export interface SwipeEvent {
  dx: number;
  dy: number;
  distancePx: number;
  speedPxPerSec: number;
  startX: number;
  startY: number;
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
  private blockHoldTimer: number | null = null;
  private isHoldingBlock = false;

  // Desktop keyboard fallback
  private keys = new Set<string>();
  public enabled = true;

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
    if (e.clientX < halfW && this.leftPointerId === null) {
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
    } else if (e.clientX >= halfW && this.rightPointerId === null) {
      this.rightPointerId = e.pointerId;
      this.rightStartX = e.clientX;
      this.rightStartY = e.clientY;
      this.rightStartTime = performance.now();
      this.rightMaxDist = 0;

      // Tap & Hold to Block after 130ms if finger hasn't swiped far
      this.blockHoldTimer = window.setTimeout(() => {
        if (this.rightPointerId !== null && this.rightMaxDist < 28) {
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

  private onPointerMove = (e: PointerEvent): void => {
    if (e.pointerId === this.leftPointerId) {
      this.updateLeftThumb(e.clientX, e.clientY);
    } else if (e.pointerId === this.rightPointerId) {
      const dist = Math.hypot(e.clientX - this.rightStartX, e.clientY - this.rightStartY);
      this.rightMaxDist = Math.max(this.rightMaxDist, dist);
      if (this.rightMaxDist > 30 && this.isHoldingBlock) {
        this.isHoldingBlock = false;
        this.callbacks.onBlockEnd();
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

      if (this.isHoldingBlock) {
        this.isHoldingBlock = false;
        this.callbacks.onBlockEnd();
      } else {
        const dx = e.clientX - this.rightStartX;
        const dy = e.clientY - this.rightStartY;
        const dist = Math.hypot(dx, dy);
        const elapsedSec = Math.max(0.04, (performance.now() - this.rightStartTime) / 1000);
        if (dist >= 16) {
          this.callbacks.onSwipe({
            dx,
            dy,
            distancePx: dist,
            speedPxPerSec: dist / elapsedSec,
            startX: this.rightStartX,
            startY: this.rightStartY,
          });
        }
      }
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
