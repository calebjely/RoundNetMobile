import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
import { BotController } from './ai/BotController';
import { PHASE1_LINEUP, TEAM_COLORS, TeamId } from './config/characters';
import {
  CourtOffsetConfig,
  DEFAULT_MAP_ID,
  fetchRemoteCourtConfig,
  IntroCameraStyle,
  loadLocalCourtConfig,
  MAPS,
  persistCourtConfig,
} from './config/maps';
import { CharacterController } from './engine/CharacterController';
import { InputManager, JoystickVisualState } from './engine/InputManager';
import { MatchHUDState, MatchManager, TimingPopup } from './engine/MatchManager';
import { PhysicsWorld } from './engine/PhysicsWorld';
import { OffscreenLandingHint, SceneManager } from './engine/SceneManager';
import { CalibratorTab } from './ui/CalibratorPanel';
import { GameHUD } from './ui/GameHUD';
import './styles.css';

const App: React.FC = () => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapConfig = MAPS[DEFAULT_MAP_ID];
  const initialSaved = useRef(loadLocalCourtConfig(mapConfig));

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
  const [offscreenLanding, setOffscreenLanding] = useState<OffscreenLandingHint>({
    visible: false,
    screenX: 0,
    screenY: 0,
    angleDeg: 0,
    teamColor: '#3b82f6',
  });
  const [returnToNetActive, setReturnToNetActive] = useState(false);
  const [calibrateMode, setCalibrateMode] = useState(
    () => new URLSearchParams(window.location.search).get('calibrate') === '1'
  );
  const [calibrateTab, setCalibrateTab] = useState<CalibratorTab>('camera');
  const [calibrateServeSlot, setCalibrateServeSlot] = useState<number>(0);
  const [cameraViewMode, setCameraViewMode] = useState<'pressbox' | 'first_person'>('pressbox');
  const [introStyle, setIntroStyle] = useState<IntroCameraStyle>(
    initialSaved.current.introCameraStyle
  );
  const [courtOffset, setCourtOffset] = useState<CourtOffsetConfig>(
    initialSaved.current.courtOffset
  );
  const [physicsSpeed, setPhysicsSpeed] = useState<number>(initialSaved.current.physicsSpeed);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');

  const physicsSpeedRef = useRef<number>(initialSaved.current.physicsSpeed);
  const saveTimerRef = useRef<number | null>(null);

  const engineRef = useRef<{
    sceneMgr: SceneManager;
    matchMgr: MatchManager;
    inputMgr: InputManager;
    human: CharacterController;
    returnToNet: boolean;
  } | null>(null);

  const saveConfigToBackend = useCallback(async () => {
    const inst = engineRef.current;
    if (!inst) return;
    setSaveStatus('saving');
    const cfg = inst.sceneMgr.getSavedConfig(physicsSpeedRef.current);
    await persistCourtConfig(cfg);
    setSaveStatus('saved');
    window.setTimeout(() => setSaveStatus('idle'), 1500);
  }, []);

  const scheduleAutoSave = useCallback(() => {
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      saveConfigToBackend();
    }, 550);
  }, [saveConfigToBackend]);

  useEffect(() => {
    const container = hostRef.current;
    if (!container) return;

    let disposed = false;
    let rafId = 0;

    const sceneMgr = new SceneManager(container, mapConfig, initialSaved.current);
    const initialCalibrate = new URLSearchParams(window.location.search).get('calibrate') === '1';
    if (initialCalibrate) {
      sceneMgr.setCalibrateMode(true);
    } else {
      sceneMgr.startIntroSpin();
    }

    sceneMgr.setCourtOffsetSyncCallback((next) => {
      setCourtOffset(next);
      scheduleAutoSave();
    });
    sceneMgr.setCameraPresetChangedCallback(() => {
      scheduleAutoSave();
    });

    const physics = new PhysicsWorld();
    const players: CharacterController[] = PHASE1_LINEUP.map(
      (cfg) => new CharacterController(cfg, sceneMgr.scene)
    );
    const human = players.find((p) => p.isHuman)!;

    let matchMgr: MatchManager;
    let bots: BotController;
    let inputMgr: InputManager;

    const init = async () => {
      // Sync remote R2-persisted config if available
      fetchRemoteCourtConfig(mapConfig).then((remote) => {
        if (disposed || !remote) return;
        sceneMgr.applySavedConfig(remote);
        setCourtOffset(remote.courtOffset);
        setPhysicsSpeed(remote.physicsSpeed);
        setIntroStyle(remote.introCameraStyle);
        physicsSpeedRef.current = remote.physicsSpeed;
      });

      await physics.init({
        onNetHit: (x, z, speed) => matchMgr?.onNetHit(x, z, speed),
        onRimHit: (x, z) => matchMgr?.onRimHit(x, z),
        onGroundHit: (x, z) => matchMgr?.onGroundHit(x, z),
        onObstacleHit: (x, y, z) => matchMgr?.onObstacleHit(x, y, z),
      });
      if (disposed) return;

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
        onSwipe: (swipe) => {
          sceneMgr.skipIntroSpin();
          const camFwd = new THREE.Vector3();
          sceneMgr.camera.getWorldDirection(camFwd);
          camFwd.y = 0;
          if (camFwd.lengthSq() > 0.0001) camFwd.normalize();
          const camRight = new THREE.Vector3()
            .crossVectors(camFwd, new THREE.Vector3(0, 1, 0))
            .normalize();
          matchMgr.handleHumanSwipe(swipe, camRight);
        },
        onBlockStart: () => {
          sceneMgr.skipIntroSpin();
          human.isBlocking = true;
        },
        onBlockEnd: () => {
          human.isBlocking = false;
        },
        onReturnToNetCancel: () => {
          sceneMgr.skipIntroSpin();
          if (engineRef.current) {
            engineRef.current.returnToNet = false;
          }
          setReturnToNetActive(false);
        },
      });
      inputMgr.enabled = !initialCalibrate;

      engineRef.current = {
        sceneMgr,
        matchMgr,
        inputMgr,
        human,
        returnToNet: false,
      };

      const onKeyDown = (e: KeyboardEvent) => {
        if (e.code === 'F2') {
          const next = !sceneMgr.isCalibrateMode();
          sceneMgr.setCalibrateMode(next);
          inputMgr.enabled = !next;
          setCalibrateMode(next);
          if (!next) saveConfigToBackend();
        }
      };
      window.addEventListener('keydown', onKeyDown);

      const onContextMenu = (e: MouseEvent) => e.preventDefault();
      container.addEventListener('contextmenu', onContextMenu);

      let lastTime = performance.now();
      let hudSyncAccum = 0;
      let physicsAccum = 0;
      const fixedDt = 1 / 60;
      const ballPos = new THREE.Vector3();

      const tick = (now: number) => {
        if (disposed) return;
        const rawDt = Math.min(0.05, Math.max(0.001, (now - lastTime) / 1000));
        lastTime = now;

        const speedMult = physicsSpeedRef.current;
        const simDt = rawDt * speedMult;

        // Switch press-box camera preset automatically when the server slot rotates
        const activeServerSlot = matchMgr.getCurrentServer().config.slotIndex;
        sceneMgr.setActiveServeCamera(activeServerSlot);

        // Human movement (Joystick or Return-to-Net auto-sprint)
        let { dir, deflection } = inputMgr.getMoveIntent();
        if (deflection > 0.04) {
          sceneMgr.skipIntroSpin();
          const camForward = new THREE.Vector3();
          sceneMgr.camera.getWorldDirection(camForward);
          camForward.y = 0;
          if (camForward.lengthSq() > 0.0001) {
            camForward.normalize();
          } else {
            camForward.set(0, 0, -1);
          }
          const camRight = new THREE.Vector3()
            .crossVectors(camForward, new THREE.Vector3(0, 1, 0))
            .normalize();

          const worldX = camRight.x * dir.x + camForward.x * -dir.y;
          const worldZ = camRight.z * dir.x + camForward.z * -dir.y;
          dir.set(worldX, worldZ).normalize();
        }
        if (engineRef.current?.returnToNet && deflection < 0.05) {
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

        const isPreServe =
          matchMgr.phase === 'SERVE_WAIT_TOSS' || matchMgr.phase === 'SERVE_METER_ACTIVE';
        human.update(simDt, dir, deflection, isPreServe);
        bots.update(simDt);

        // Fixed-timestep physics accumulator so mobile 30fps runs at true 1.0x+ normal speed!
        physicsAccum += Math.min(simDt, 0.1);
        let substeps = 0;
        while (physicsAccum >= fixedDt && substeps < 5) {
          physics.step(fixedDt);
          matchMgr.update(fixedDt);
          physicsAccum -= fixedDt;
          substeps++;
        }

        sceneMgr.updateNetRipple(rawDt);

        physics.getBallPosition(ballPos);
        sceneMgr.ballMesh.position.copy(ballPos);
        const ballVel = physics.getBallVelocity();
        sceneMgr.ballMesh.rotation.x += ballVel.z * simDt * 2.5;
        sceneMgr.ballMesh.rotation.z -= ballVel.x * simDt * 2.5;

        const isBallLive =
          matchMgr.phase === 'RALLY_LIVE' ||
          matchMgr.phase === 'SERVE_IN_FLIGHT' ||
          matchMgr.phase === 'SERVE_METER_ACTIVE';
        const isAimedAfterHit =
          (matchMgr.phase === 'SERVE_IN_FLIGHT' && !matchMgr.serveReboundedOffNet) ||
          (matchMgr.phase === 'RALLY_LIVE' && matchMgr.teamTouches > 0);
        const activeBallTeam: TeamId =
          matchMgr.phase === 'SERVE_IN_FLIGHT'
            ? matchMgr.serveReboundedOffNet
              ? matchMgr.getServingTeam() === 'A'
                ? 'B'
                : 'A'
              : matchMgr.getServingTeam()
            : matchMgr.phase === 'SERVE_METER_ACTIVE'
              ? matchMgr.getServingTeam()
              : matchMgr.possessionTeam;
        const teamMeta = TEAM_COLORS[activeBallTeam];
        sceneMgr.updateBallIndicators(
          ballPos,
          ballVel,
          isBallLive,
          isAimedAfterHit,
          teamMeta.hex,
          teamMeta.primary
        );

        const tracked = players.map((p) => p.position);
        tracked.push(ballPos);
        sceneMgr.updateCamera(tracked, ballPos, human.position, rawDt);
        sceneMgr.render();

        hudSyncAccum += rawDt;
        if (hudSyncAccum >= 0.05) {
          hudSyncAccum = 0;
          setHud(matchMgr.getHUDState());
          setJoystick({ ...inputMgr.joystickState });
          setPopups([...matchMgr.popups]);
          setOffscreenLanding(sceneMgr.getOffscreenLandingHint());
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
      if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
      cleanupPromise.then((fn) => fn?.());
      inputMgr?.dispose();
      sceneMgr.dispose();
      if (sceneMgr.renderer.domElement.parentElement === container) {
        container.removeChild(sceneMgr.renderer.domElement);
      }
    };
  }, [mapConfig, saveConfigToBackend, scheduleAutoSave]);

  const handleToggleCalibrate = () => {
    const inst = engineRef.current;
    if (!inst) return;
    const next = !inst.sceneMgr.isCalibrateMode();
    inst.sceneMgr.setCalibrateMode(next);
    inst.inputMgr.enabled = !next;
    setCalibrateMode(next);
    if (!next) {
      saveConfigToBackend();
    }
  };

  const handleChangeCalibrateTab = (tab: CalibratorTab) => {
    setCalibrateTab(tab);
    engineRef.current?.sceneMgr.setCalibrateTab(tab);
  };

  const handleChangeCalibrateServeSlot = (slot: number) => {
    setCalibrateServeSlot(slot);
    engineRef.current?.sceneMgr.setCalibrateServeSlot(slot);
    scheduleAutoSave();
  };

  return (
    <div className="app-shell">
      <div ref={hostRef} className="canvas-host" />
      {hud && (
        <GameHUD
          hud={hud}
          joystick={joystick}
          popups={popups}
          offscreenLanding={offscreenLanding}
          returnToNetActive={returnToNetActive}
          onReturnToNetPress={(active) => {
            if (engineRef.current) {
              engineRef.current.returnToNet = active;
            }
            setReturnToNetActive(active);
          }}
          onResetRally={() => engineRef.current?.matchMgr.resetRally()}
          onResetMatch={(pts) => {
            engineRef.current?.matchMgr.resetMatch(pts);
            engineRef.current?.sceneMgr.startIntroSpin();
          }}
          calibrateMode={calibrateMode}
          calibrateTab={calibrateTab}
          calibrateServeSlot={calibrateServeSlot}
          onChangeCalibrateTab={handleChangeCalibrateTab}
          onChangeCalibrateServeSlot={handleChangeCalibrateServeSlot}
          onToggleCalibrate={handleToggleCalibrate}
          cameraViewMode={cameraViewMode}
          onChangeCameraViewMode={(mode) => {
            setCameraViewMode(mode);
            const inst = engineRef.current;
            if (inst) {
              inst.sceneMgr.setCameraViewMode(mode);
              inst.human.root.visible = mode !== 'first_person';
            }
          }}
          introStyle={introStyle}
          onChangeIntroStyle={(style) => {
            setIntroStyle(style);
            const inst = engineRef.current;
            if (inst) {
              inst.sceneMgr.setIntroStyle(style);
              inst.sceneMgr.startIntroSpin(style);
              scheduleAutoSave();
            }
          }}
          courtOffset={courtOffset}
          physicsSpeed={physicsSpeed}
          onChangeOffset={(next) => {
            setCourtOffset(next);
            engineRef.current?.sceneMgr.setCourtOffset(next);
            scheduleAutoSave();
          }}
          onChangePhysicsSpeed={(spd) => {
            setPhysicsSpeed(spd);
            physicsSpeedRef.current = spd;
            scheduleAutoSave();
          }}
          saveStatus={saveStatus}
          onSaveNow={saveConfigToBackend}
        />
      )}
    </div>
  );
};

createRoot(document.getElementById('root')!).render(<App />);
