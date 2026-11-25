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
import { InputManager, SwipeVisualState } from './engine/InputManager';
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
  const [practiceMode, setPracticeMode] = useState(false);
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
          inputMgr.fullScreenSwipe = true;
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
        },
      });
      inputMgr.enabled = !initialCalibrate;
      inputMgr.fullScreenSwipe = true;
      inputMgr.getSwipeTarget = () => {
        if (
          matchMgr.phase === 'SERVE_WAIT_TOSS' ||
          matchMgr.phase === 'SERVE_METER_ACTIVE'
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
        const screenTarget = sceneMgr.getBallScreenTarget(bPos, contact.quality01);
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

        // Auto-runner across ALL camera views (Press Box, Follow Behind, 1st Person):
        // character automatically runs to play; gameplay centers on timing & swipe direction!
        const plrSpd = playerSpeedRef.current;
        bots.updateHumanAutoMove(simDt, plrSpd, stanceRef.current);

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
          (matchMgr.phase === 'SERVE_IN_FLIGHT' &&
            !matchMgr.serveReboundedOffNet &&
            matchMgr.getServingTeam() === human.team) ||
          (matchMgr.phase === 'RALLY_LIVE' &&
            matchMgr.teamTouches > 0 &&
            matchMgr.possessionTeam === human.team);
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
            contact.quality01,
            contact.zone,
            contact.inRange
          );
        } else {
          sceneMgr.updateTimingRing(false, ballPos, 0, 'yellow', false);
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
      inst.inputMgr.fullScreenSwipe = true;
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
          onResetRally={() => engineRef.current?.matchMgr.resetRally()}
          onResetMatch={(pts) => {
            engineRef.current?.matchMgr.resetMatch(pts);
            engineRef.current?.sceneMgr.startIntroSpin();
          }}
          calibrateMode={calibrateMode}
          calibrateTab={calibrateTab}
          onChangeCalibrateTab={handleChangeCalibrateTab}
          onToggleCalibrate={handleToggleCalibrate}
          practiceMode={practiceMode}
          onTogglePracticeMode={() => {
            const next = !practiceMode;
            setPracticeMode(next);
            engineRef.current?.matchMgr.setPracticeMode(next);
          }}
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
