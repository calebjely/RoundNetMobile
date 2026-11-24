import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
import { BotController } from './ai/BotController';
import { PHASE1_LINEUP } from './config/characters';
import { CourtOffsetConfig, DEFAULT_MAP_ID, MAPS } from './config/maps';
import { CharacterController } from './engine/CharacterController';
import { InputManager, JoystickVisualState } from './engine/InputManager';
import { MatchHUDState, MatchManager, TimingPopup } from './engine/MatchManager';
import { PhysicsWorld } from './engine/PhysicsWorld';
import { SceneManager } from './engine/SceneManager';
import { GameHUD } from './ui/GameHUD';
import './styles.css';

const App: React.FC = () => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapConfig = MAPS[DEFAULT_MAP_ID];

  const [hud, setHud] = useState<MatchHUDState | null>(null);
  const [joystick, setJoystick] = useState<JoystickVisualState>({
    active: false,
    originX: 0,
    originY: 0,
    thumbX: 0,
    thumbY: 0,
    deflection: 0,
    isSprint: false,
  });
  const [popups, setPopups] = useState<TimingPopup[]>([]);
  const [returnToNetActive, setReturnToNetActive] = useState(false);
  const [calibrateMode, setCalibrateMode] = useState(
    () => new URLSearchParams(window.location.search).get('calibrate') === '1'
  );
  const [courtOffset, setCourtOffset] = useState<CourtOffsetConfig>(mapConfig.courtOffset);
  const [fov, setFov] = useState<number>(mapConfig.fov);

  const engineRef = useRef<{
    sceneMgr: SceneManager;
    matchMgr: MatchManager;
    human: CharacterController;
    returnToNet: boolean;
  } | null>(null);

  useEffect(() => {
    const container = hostRef.current;
    if (!container) return;

    let disposed = false;
    let rafId = 0;

    const sceneMgr = new SceneManager(container, mapConfig);
    if (new URLSearchParams(window.location.search).get('calibrate') === '1') {
      sceneMgr.setCalibrateMode(true);
    }

    const physics = new PhysicsWorld();
    const players: CharacterController[] = PHASE1_LINEUP.map(
      (cfg) => new CharacterController(cfg, sceneMgr.scene)
    );
    const human = players.find((p) => p.isHuman)!;

    let matchMgr: MatchManager;
    let bots: BotController;
    let inputMgr: InputManager;

    const init = async () => {
      await physics.init({
        onNetHit: (x, z, speed) => matchMgr?.onNetHit(x, z, speed),
        onRimHit: (x, z) => matchMgr?.onRimHit(x, z),
        onGroundHit: (x, z) => matchMgr?.onGroundHit(x, z),
        onObstacleHit: (x, y, z) => matchMgr?.onObstacleHit(x, y, z),
      });
      if (disposed) return;

      // Load map splat/collision & character models asynchronously
      const mapResult = await sceneMgr.loadMapAssets();
      if (disposed) return;
      if (mapResult.collisionRoot) {
        physics.registerEnvironmentColliders(mapResult.collisionRoot);
      }

      await Promise.all(players.map((p) => p.initModel()));
      if (disposed) return;

      matchMgr = new MatchManager(players, physics, sceneMgr.camera, (x, z, speed) =>
        sceneMgr.triggerNetRipple(x, z, speed)
      );
      bots = new BotController(players, physics, matchMgr);

      inputMgr = new InputManager(container, {
        onSwipe: (swipe) => matchMgr.handleHumanSwipe(swipe),
        onBlockStart: () => {
          human.isBlocking = true;
        },
        onBlockEnd: () => {
          human.isBlocking = false;
        },
        onReturnToNetCancel: () => {
          if (engineRef.current) {
            engineRef.current.returnToNet = false;
          }
          setReturnToNetActive(false);
        },
      });

      engineRef.current = {
        sceneMgr,
        matchMgr,
        human,
        returnToNet: false,
      };

      const onKeyDown = (e: KeyboardEvent) => {
        if (e.code === 'F2') {
          const next = !sceneMgr.isCalibrateMode();
          sceneMgr.setCalibrateMode(next);
          setCalibrateMode(next);
        }
      };
      window.addEventListener('keydown', onKeyDown);

      // Disable browser context menu on long press
      const onContextMenu = (e: MouseEvent) => e.preventDefault();
      container.addEventListener('contextmenu', onContextMenu);

      let lastTime = performance.now();
      let hudSyncAccum = 0;
      const ballPos = new THREE.Vector3();

      const tick = (now: number) => {
        if (disposed) return;
        const dt = Math.min(0.05, Math.max(0.001, (now - lastTime) / 1000));
        lastTime = now;

        // Human movement (Joystick or Return-to-Net auto-sprint)
        let { dir, deflection } = inputMgr.getMoveIntent();
        if (engineRef.current?.returnToNet && deflection < 0.05) {
          // Optimal defensive net spacing (~2.5 m from (0,0,0) on human's side)
          const target = new THREE.Vector3(0, 0, 2.5);
          const toTarget = target.sub(human.position);
          const dist = Math.hypot(toTarget.x, toTarget.z);
          if (dist > 0.25) {
            dir.set(toTarget.x / dist, toTarget.z / dist);
            deflection = 0.92;
          } else {
            engineRef.current.returnToNet = false;
            setReturnToNetActive(false);
          }
        }

        human.update(dt, dir, deflection);
        bots.update(dt);
        physics.step(dt);
        matchMgr.update(dt);
        sceneMgr.updateNetRipple(dt);

        physics.getBallPosition(ballPos);
        sceneMgr.ballMesh.position.copy(ballPos);
        const ballVel = physics.getBallVelocity();
        sceneMgr.ballMesh.rotation.x += ballVel.z * dt * 2.5;
        sceneMgr.ballMesh.rotation.z -= ballVel.x * dt * 2.5;

        const tracked = players.map((p) => p.position);
        tracked.push(ballPos);
        sceneMgr.updateCamera(tracked, dt);
        sceneMgr.render();

        hudSyncAccum += dt;
        if (hudSyncAccum >= 0.05) {
          hudSyncAccum = 0;
          setHud(matchMgr.getHUDState());
          setJoystick({ ...inputMgr.joystickState });
          setPopups([...matchMgr.popups]);
        }

        rafId = requestAnimationFrame(tick);
      };

      setHud(matchMgr.getHUDState());
      rafId = requestAnimationFrame(tick);

      return () => {
        window.removeEventListener('keydown', onKeyDown);
        container.removeEventListener('contextmenu', onContextMenu);
      };
    };

    const cleanupPromise = init();

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      cleanupPromise.then((fn) => fn?.());
      inputMgr?.dispose();
      sceneMgr.dispose();
      if (sceneMgr.renderer.domElement.parentElement === container) {
        container.removeChild(sceneMgr.renderer.domElement);
      }
    };
  }, [mapConfig]);

  const handleToggleCalibrate = () => {
    const inst = engineRef.current;
    if (!inst) return;
    const next = !inst.sceneMgr.isCalibrateMode();
    inst.sceneMgr.setCalibrateMode(next);
    setCalibrateMode(next);
  };

  return (
    <div className="app-shell">
      <div ref={hostRef} className="canvas-host" />
      {hud && (
        <GameHUD
          hud={hud}
          joystick={joystick}
          popups={popups}
          returnToNetActive={returnToNetActive}
          onReturnToNetPress={(active) => {
            if (engineRef.current) {
              engineRef.current.returnToNet = active;
            }
            setReturnToNetActive(active);
          }}
          onResetRally={() => engineRef.current?.matchMgr.resetRally()}
          onResetMatch={(pts) => engineRef.current?.matchMgr.resetMatch(pts)}
          calibrateMode={calibrateMode}
          onToggleCalibrate={handleToggleCalibrate}
          courtOffset={courtOffset}
          fov={fov}
          onChangeOffset={(next) => {
            setCourtOffset(next);
            engineRef.current?.sceneMgr.setCourtOffset(next);
          }}
          onChangeFov={(nextFov) => {
            setFov(nextFov);
            engineRef.current?.sceneMgr.setFov(nextFov);
          }}
          onCopyViewConfig={() => engineRef.current?.sceneMgr.getViewConfigJson() ?? '{}'}
        />
      )}
    </div>
  );
};

createRoot(document.getElementById('root')!).render(<App />);
