import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
import { BotController } from './ai/BotController';
import { PHASE1_LINEUP, TEAM_COLORS, TeamId } from './config/characters';
import {
  CameraViewMode,
  CameraViewSettings,
  CourtOffsetConfig,
  DEFAULT_MAP_ID,
  fetchRemoteCourtConfig,
  IntroCameraStyle,
  loadLocalCourtConfig,
  MAPS,
  persistCourtConfig,
} from './config/maps';
import { CharacterController } from './engine/CharacterController';
import { InputManager, JoystickVisualState, SwipeVisualState } from './engine/InputManager';
import { FeedEntry, MatchHUDState, MatchManager, TimingPopup } from './engine/MatchManager';
import { PhysicsWorld } from './engine/PhysicsWorld';
import {
  FirstPersonHints,
  OffscreenLandingHint,
  SceneManager,
} from './engine/SceneManager';
import { ShotResolver } from './engine/ShotResolver';
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
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [offscreenLanding, setOffscreenLanding] = useState<OffscreenLandingHint>({
    visible: false,
    screenX: 0,
    screenY: 0,
    angleDeg: 0,
    teamColor: '#3b82f6',
  });
  const [fpHints, setFpHints] = useState<FirstPersonHints>({
    netEdge: { visible: false, screenX: 0, screenY: 0, angleDeg: 0, teamColor: '#facc15' },
    partnerEdge: { visible: false, screenX: 0, screenY: 0, angleDeg: 0, teamColor: '#60a5fa' },
    enemyEdges: [],
  });
  const [ballInRange, setBallInRange] = useState(false);
  const [swipeVisual, setSwipeVisual] = useState<SwipeVisualState>({
    active: false,
    startX: 0,
    startY: 0,
    curX: 0,
    curY: 0,
    onBall: false,
    inRange: false,
  });
  const [stance, setStance] = useState<'close' | 'away'>('close');
  const [returnToNetActive, setReturnToNetActive] = useState(false);
  const [calibrateMode, setCalibrateMode] = useState(
    () => new URLSearchParams(window.location.search).get('calibrate') === '1'
  );
  const [calibrateTab, setCalibrateTab] = useState<CalibratorTab>('camera');
  const [cameraViewMode, setCameraViewMode] = useState<CameraViewMode>(
    initialSaved.current.cameraViewMode
  );
  const [viewSettings, setViewSettings] = useState<CameraViewSettings>(
    initialSaved.current.cameraViewSettings
  );
  const [introStyle, setIntroStyle] = useState<IntroCameraStyle>(
    initialSaved.current.introCameraStyle
  );
  const [courtOffset, setCourtOffset] = useState<CourtOffsetConfig>(
    initialSaved.current.courtOffset
  );
  const [physicsSpeed, setPhysicsSpeed] = useState<number>(initialSaved.current.physicsSpeed);
  const [playerSpeed, setPlayerSpeed] = useState<number>(initialSaved.current.playerSpeed);
  const [isHumanBlocking, setIsHumanBlocking] = useState<boolean>(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');

  const physicsSpeedRef = useRef<number>(initialSaved.current.physicsSpeed);
  const playerSpeedRef = useRef<number>(initialSaved.current.playerSpeed);
  const stanceRef = useRef<'close' | 'away'>('close');
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
    const cfg = inst.sceneMgr.getSavedConfig(
      physicsSpeedRef.current,
      playerSpeedRef.current
    );
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

    // Try auto-entering fullscreen/landscape if allowed by browser/PWA context
    try {
      const el = document.documentElement as HTMLElement & {
        webkitRequestFullscreen?: () => Promise<void>;
      };
      if (!document.fullscreenElement) {
        if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
        else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen().catch(() => {});
      }
      const orient = screen.orientation as ScreenOrientation & {
        lock?: (o: string) => Promise<void>;
      };
      orient?.lock?.('landscape')?.catch(() => {});
    } catch {
      // ignore when browser requires explicit user gesture
    }

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
        setCameraViewMode(remote.cameraViewMode);
        setViewSettings(remote.cameraViewSettings);
        setPhysicsSpeed(remote.physicsSpeed);
        setPlayerSpeed(remote.playerSpeed);
        setIntroStyle(remote.introCameraStyle);
        physicsSpeedRef.current = remote.physicsSpeed;
        playerSpeedRef.current = remote.playerSpeed;
        human.root.visible = remote.cameraViewMode !== 'first_person';
        if (inputMgr) {
          inputMgr.fullScreenSwipe = remote.cameraViewMode === 'first_person';
        }
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

      // Default to 1st-Person Auto-Runner mode on boot
      human.root.visible = sceneMgr.getCameraViewMode() !== 'first_person';

      matchMgr = new MatchManager(players, physics, sceneMgr.camera, (x, z, speed) =>
        sceneMgr.triggerNetRipple(x, z, speed)
      );
      bots = new BotController(players, physics, matchMgr);

      inputMgr = new InputManager(container, {
        onSwipe: (swipe) => {
          sceneMgr.skipIntroSpin();
          sceneMgr.triggerFirstPersonSwing(swipe.dx, swipe.dy, swipe.speedPxPerSec);
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
          sceneMgr.setFirstPersonBlock(true);
        },
        onBlockEnd: () => {
          human.isBlocking = false;
          sceneMgr.setFirstPersonBlock(false);
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
      inputMgr.fullScreenSwipe = sceneMgr.getCameraViewMode() === 'first_person';
      inputMgr.getSwipeTarget = () => {
        if (
          matchMgr.phase === 'SERVE_WAIT_TOSS' ||
          matchMgr.phase === 'SERVE_METER_ACTIVE' ||
          sceneMgr.getCameraViewMode() !== 'first_person'
        ) {
          return null;
        }
        const isHumansTurn =
          (matchMgr.phase === 'SERVE_IN_FLIGHT' &&
            matchMgr.serveReboundedOffNet &&
            human.team !== matchMgr.getServingTeam()) ||
          (matchMgr.phase === 'RALLY_LIVE' &&
            matchMgr.possessionTeam === human.team &&
            matchMgr.lastTouchPlayerIdx !== human.config.slotIndex);
        if (!isHumansTurn) {
          return { x: -999, y: -999, radiusPx: 1, inRange: false, allowAnywhere: false };
        }
        const bPos = physics.getBallPosition();
        const bVel = physics.getBallVelocity();
        const contact = ShotResolver.evaluateContactTiming(bPos, bVel, human.position);
        const screenTarget = sceneMgr.getBallScreenTarget(bPos);
        if (!screenTarget) {
          return {
            x: window.innerWidth * 0.5,
            y: window.innerHeight * 0.5,
            radiusPx: 92,
            inRange: contact.inRange,
            allowAnywhere: false,
          };
        }
        return {
          ...screenTarget,
          inRange: contact.inRange,
          allowAnywhere: false,
        };
      };

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
        const isPreServe =
          matchMgr.phase === 'SERVE_WAIT_TOSS' || matchMgr.phase === 'SERVE_METER_ACTIVE';
        const plrSpd = playerSpeedRef.current;

        if (sceneMgr.getCameraViewMode() === 'first_person') {
          // 1st-Person Auto-Runner: character automatically runs & positions; user only swipes!
          bots.updateHumanAutoMove(simDt, plrSpd, stanceRef.current);
        } else {
          if (engineRef.current?.returnToNet && deflection < 0.05) {
            const curR = Math.hypot(human.position.x, human.position.z);
            const curAngle = curR > 0.01 ? Math.atan2(human.position.x, human.position.z) : 0;
            const desiredRadius = isPreServe ? 2.66 : 0.68;
            const target = new THREE.Vector3(
              Math.sin(curAngle) * desiredRadius,
              0,
              Math.cos(curAngle) * desiredRadius
            );
            const toTarget = target.sub(human.position);
            const dist = Math.hypot(toTarget.x, toTarget.z);
            if (dist > 0.16) {
              dir.set(toTarget.x / dist, toTarget.z / dist);
              deflection = 0.92;
            } else {
              engineRef.current.returnToNet = false;
              setReturnToNetActive(false);
            }
          }
          human.update(simDt, dir, deflection, isPreServe, plrSpd);
        }

        bots.update(simDt, plrSpd);

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
        const teammate = players.find(
          (p) => p.team === human.team && p.config.slotIndex !== human.config.slotIndex
        );
        const enemyPositions = players
          .filter((p) => p.team !== human.team)
          .map((p) => p.position);
        sceneMgr.updateBallIndicators(
          ballPos,
          ballVel,
          isBallLive,
          isAimedAfterHit,
          teamMeta.hex,
          teamMeta.primary,
          teammate?.position,
          enemyPositions
        );

        const isHumansTurn =
          (matchMgr.phase === 'SERVE_IN_FLIGHT' &&
            matchMgr.serveReboundedOffNet &&
            human.team !== matchMgr.getServingTeam()) ||
          (matchMgr.phase === 'RALLY_LIVE' &&
            matchMgr.possessionTeam === human.team &&
            matchMgr.lastTouchPlayerIdx !== human.config.slotIndex);
        const distToBall = Math.hypot(
          ballPos.x - human.position.x,
          ballPos.z - human.position.z
        );
        let latestInRange = false;
        if (isHumansTurn && distToBall <= 5.6 && ballPos.y > 0.14) {
          const contact = ShotResolver.evaluateContactTiming(ballPos, ballVel, human.position);
          latestInRange = contact.inRange;
          sceneMgr.updateTimingRing(
            true,
            ballPos,
            contact.ringProgress,
            contact.zone,
            contact.inRange
          );
        } else {
          sceneMgr.updateTimingRing(false, ballPos, 1, 'yellow', false);
        }

        sceneMgr.updateFirstPersonArm(rawDt);

        const tracked = players.map((p) => p.position);
        tracked.push(ballPos);
        sceneMgr.updateCamera(tracked, ballPos, human.position, rawDt);
        sceneMgr.render();

        hudSyncAccum += rawDt;
        if (hudSyncAccum >= 0.033) {
          hudSyncAccum = 0;
          setHud(matchMgr.getHUDState());
          setFeed([...matchMgr.feed]);
          setJoystick({ ...inputMgr.joystickState });
          setPopups([...matchMgr.popups]);
          setOffscreenLanding(sceneMgr.getOffscreenLandingHint());
          setFpHints(sceneMgr.getFirstPersonHints());
          setBallInRange(latestInRange);
          setSwipeVisual({ ...inputMgr.swipeVisual });
          setIsHumanBlocking(human.isBlocking);
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

  const handleChangeCameraViewMode = (mode: CameraViewMode) => {
    setCameraViewMode(mode);
    const inst = engineRef.current;
    if (inst) {
      inst.sceneMgr.setCameraViewMode(mode);
      inst.human.root.visible = mode !== 'first_person';
      inst.inputMgr.fullScreenSwipe = mode === 'first_person';
      scheduleAutoSave();
    }
  };

  const handleChangeViewSettings = (next: CameraViewSettings) => {
    setViewSettings(next);
    engineRef.current?.sceneMgr.setViewSettings(next);
    scheduleAutoSave();
  };

  return (
    <div className="app-shell">
      <div ref={hostRef} className="canvas-host" />
      {hud && (
        <GameHUD
          hud={hud}
          feed={feed}
          joystick={joystick}
          popups={popups}
          offscreenLanding={offscreenLanding}
          fpHints={fpHints}
          ballInRange={ballInRange}
          swipeVisual={swipeVisual}
          stance={stance}
          onToggleStance={() => {
            const next = stanceRef.current === 'close' ? 'away' : 'close';
            stanceRef.current = next;
            setStance(next);
          }}
          isHumanBlocking={isHumanBlocking}
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
          onChangeCalibrateTab={handleChangeCalibrateTab}
          onToggleCalibrate={handleToggleCalibrate}
          cameraViewMode={cameraViewMode}
          onChangeCameraViewMode={handleChangeCameraViewMode}
          viewSettings={viewSettings}
          onChangeViewSettings={handleChangeViewSettings}
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
          playerSpeed={playerSpeed}
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
          onChangePlayerSpeed={(spd) => {
            setPlayerSpeed(spd);
            playerSpeedRef.current = spd;
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
