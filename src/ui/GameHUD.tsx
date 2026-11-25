import React, { useEffect, useState } from 'react';
import {
  CameraViewMode,
  CameraViewSettings,
  CourtOffsetConfig,
  IntroCameraStyle,
} from '../config/maps';
import { SwipeVisualState } from '../engine/InputManager';
import { FeedEntry, MatchHUDState, TimingPopup } from '../engine/MatchManager';
import { FirstPersonHints, OffscreenLandingHint } from '../engine/SceneManager';
import { CalibratorPanel, CalibratorTab } from './CalibratorPanel';
import { MenuDrawer } from './MenuDrawer';

interface GameHUDProps {
  hud: MatchHUDState;
  feed: FeedEntry[];
  popups: TimingPopup[];
  offscreenLanding: OffscreenLandingHint;
  fpHints: FirstPersonHints;
  ballInRange: boolean;
  swipeVisual: SwipeVisualState;
  stance: 'close' | 'away';
  onToggleStance: () => void;
  isHumanBlocking: boolean;
  onResetRally: () => void;
  onResetMatch: (pointsToWin: 15 | 21) => void;
  calibrateMode: boolean;
  calibrateTab: CalibratorTab;
  onChangeCalibrateTab: (tab: CalibratorTab) => void;
  onToggleCalibrate: () => void;
  practiceMode: boolean;
  onTogglePracticeMode: () => void;
  cameraViewMode: CameraViewMode;
  onChangeCameraViewMode: (mode: CameraViewMode) => void;
  viewSettings: CameraViewSettings;
  onChangeViewSettings: (next: CameraViewSettings) => void;
  introStyle: IntroCameraStyle;
  onChangeIntroStyle: (style: IntroCameraStyle) => void;
  courtOffset: CourtOffsetConfig;
  physicsSpeed: number;
  playerSpeed: number;
  onChangeOffset: (next: CourtOffsetConfig) => void;
  onChangePhysicsSpeed: (speed: number) => void;
  onChangePlayerSpeed: (speed: number) => void;
  saveStatus: 'idle' | 'saving' | 'saved';
  onSaveNow: () => void;
}

export const GameHUD: React.FC<GameHUDProps> = ({
  hud,
  feed,
  popups,
  offscreenLanding,
  fpHints,
  ballInRange,
  swipeVisual,
  stance,
  onToggleStance,
  isHumanBlocking,
  onResetRally,
  onResetMatch,
  calibrateMode,
  calibrateTab,
  onChangeCalibrateTab,
  onToggleCalibrate,
  practiceMode,
  onTogglePracticeMode,
  cameraViewMode,
  onChangeCameraViewMode,
  viewSettings,
  onChangeViewSettings,
  introStyle,
  onChangeIntroStyle,
  courtOffset,
  physicsSpeed,
  playerSpeed,
  onChangeOffset,
  onChangePhysicsSpeed,
  onChangePlayerSpeed,
  saveStatus,
  onSaveNow,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [fsDismissedUnsupported, setFsDismissedUnsupported] = useState(false);

  const checkIsFullscreen = () => {
    const doc = document as Document & { webkitFullscreenElement?: Element | null };
    const isStandalone =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(display-mode: standalone)').matches;
    return Boolean(doc.fullscreenElement || doc.webkitFullscreenElement || isStandalone);
  };

  const [isFullscreen, setIsFullscreen] = useState<boolean>(checkIsFullscreen);

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(checkIsFullscreen());
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('webkitfullscreenchange', onFsChange);
    };
  }, []);

  const myScore = hud.humanTeam === 'A' ? hud.scoreA : hud.scoreB;
  const enemyScore = hud.humanTeam === 'A' ? hud.scoreB : hud.scoreA;
  const myServing = hud.servingTeam === hud.humanTeam;

  const enterFullscreenLandscape = async () => {
    const el = document.documentElement as HTMLElement & {
      webkitRequestFullscreen?: () => Promise<void>;
    };
    try {
      if (el.requestFullscreen) {
        await el.requestFullscreen();
      } else if (el.webkitRequestFullscreen) {
        await el.webkitRequestFullscreen();
      } else {
        setFsDismissedUnsupported(true);
      }
      const orient = screen.orientation as ScreenOrientation & {
        lock?: (o: string) => Promise<void>;
      };
      if (orient?.lock) {
        await orient.lock('landscape').catch(() => {});
      }
    } catch {
      if (!el.requestFullscreen && !el.webkitRequestFullscreen) {
        setFsDismissedUnsupported(true);
      }
    }
    setIsFullscreen(checkIsFullscreen());
  };

  const handleToggleFullscreen = async () => {
    try {
      const doc = document as Document & { webkitFullscreenElement?: Element | null };
      if (!doc.fullscreenElement && !doc.webkitFullscreenElement) {
        await enterFullscreenLandscape();
      } else {
        await document.exitFullscreen?.();
      }
    } catch {
      // ignore if browser blocks fullscreen
    }
  };

  return (
    <div className="hud-root">
      {/* Non-blocking Portrait Orientation Hint */}
      <div className="portrait-hint">
        Rotate to Landscape for Best Controls
      </div>

      {/* Far-Left Minimalist Scoreboard (Green = Your Team, Red = Other Team) */}
      <div className="scoreboard-mini" data-ui-interactive="true">
        <div className={`score-pill mine ${myServing ? 'serving' : ''}`}>
          <span className="score-num">{myScore}</span>
        </div>
        <div className={`score-pill enemy ${!myServing ? 'serving' : ''}`}>
          <span className="score-num">{enemyScore}</span>
        </div>
        {practiceMode && (
          <button
            className="practice-pill"
            onClick={onTogglePracticeMode}
            title="Exit Practice Mode"
          >
            PRACTICE
          </button>
        )}
      </div>

      {/* Top-Center Live Event & Coaching Feed */}
      {feed.length > 0 && (
        <div className="feed-stack" aria-live="polite">
          {feed.map((item) => (
            <div key={item.id} className={`feed-pill tone-${item.tone}`}>
              {item.text}
            </div>
          ))}
        </div>
      )}

      {/* Top-Right Retro 3D Buttons: Menu + Fullscreen directly underneath */}
      <div className="top-right-stack">
        <button
          data-ui-interactive="true"
          className="menu-btn retro-circle-btn"
          onClick={() => setMenuOpen(true)}
          aria-label="Menu"
        >
          <span className="circle-btn-icon">☰</span>
        </button>

        <button
          data-ui-interactive="true"
          className="fullscreen-btn retro-circle-btn"
          onClick={handleToggleFullscreen}
          aria-label="Toggle Fullscreen"
        >
          <span className="circle-btn-icon">⛶</span>
        </button>
      </div>

      {isHumanBlocking && (
        <div className="block-active-pill">BLOCKING</div>
      )}

      {/* Center Event Banner (Point, Fault, REDO) */}
      {hud.bannerText && (
        <div className={`center-banner tone-${hud.bannerTone}`}>
          {hud.bannerText}
        </div>
      )}

      {/* Golf-Style 2-Step Serve Timing Meter */}
      {hud.serveMeterActive && (
        <div className="serve-meter-wrap">
          <div className="serve-meter-label">SWIPE TO SERVE!</div>
          <div className="serve-meter-bar">
            <div className="serve-meter-sweet" />
            <div
              className="serve-meter-cursor"
              style={{ left: `${hud.serveMeterValue * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* World-Space Timing / Block / Redo Popups */}
      {popups.map((p) => (
        <div
          key={p.id}
          className={`timing-popup q-${p.quality.toLowerCase()}`}
          style={{ left: p.screenX, top: p.screenY }}
        >
          {p.text}
        </div>
      ))}

      {/* Off-Screen Ball Landing Indicator Arrow */}
      {offscreenLanding.visible && (
        <div
          className="offscreen-landing-arrow"
          style={{
            left: offscreenLanding.screenX,
            top: offscreenLanding.screenY,
            borderColor: offscreenLanding.teamColor,
            color: offscreenLanding.teamColor,
            transform: `translate(-50%, -50%) rotate(${offscreenLanding.angleDeg}deg)`,
          }}
        >
          ➤
        </div>
      )}

      {/* Off-Screen-Only Indicators (No text): Yellow Ring = Net, Green Arrow = Your Team, Red Arrow = Enemy */}
      {cameraViewMode !== 'pressbox' && fpHints.netEdge.visible && (
        <div
          className="fp-edge-ring net-ring"
          style={{
            left: fpHints.netEdge.screenX,
            top: fpHints.netEdge.screenY,
          }}
          aria-label="Net direction"
        />
      )}

      {cameraViewMode !== 'pressbox' && fpHints.partnerEdge.visible && (
        <div
          className="fp-edge-dot partner-dot"
          style={{
            left: fpHints.partnerEdge.screenX,
            top: fpHints.partnerEdge.screenY,
            transform: `translate(-50%, -50%) rotate(${fpHints.partnerEdge.angleDeg}deg)`,
          }}
          aria-label="Partner direction"
        >
          ➤
        </div>
      )}

      {cameraViewMode !== 'pressbox' &&
        fpHints.enemyEdges.map((edge, idx) =>
          edge.visible ? (
            <div
              key={idx}
              className="fp-edge-dot enemy-dot"
              style={{
                left: edge.screenX,
                top: edge.screenY,
                transform: `translate(-50%, -50%) rotate(${edge.angleDeg}deg)`,
              }}
              aria-label="Enemy direction"
            >
              ➤
            </div>
          ) : null
        )}

      {/* Clean In-Range Indicator */}
      {ballInRange && !hud.serveMeterActive && (
        <div className="in-range-pill">IN RANGE</div>
      )}

      {/* Touch-Ball Directional Swipe Aim Vector */}
      {swipeVisual.active &&
        Math.hypot(swipeVisual.curX - swipeVisual.startX, swipeVisual.curY - swipeVisual.startY) >
          10 && (
          <svg className="swipe-aim-svg" aria-hidden="true">
            <defs>
              <marker
                id="swipe-arrowhead"
                markerWidth="8"
                markerHeight="8"
                refX="6"
                refY="4"
                orient="auto"
              >
                <path
                  d="M 0 0 L 8 4 L 0 8 z"
                  fill={swipeVisual.inRange ? '#4ade80' : '#facc15'}
                />
              </marker>
            </defs>
            <circle
              cx={swipeVisual.startX}
              cy={swipeVisual.startY}
              r={10}
              fill="none"
              stroke={swipeVisual.inRange ? '#4ade80' : '#facc15'}
              strokeWidth="3"
              opacity="0.85"
            />
            <line
              x1={swipeVisual.startX}
              y1={swipeVisual.startY}
              x2={swipeVisual.curX}
              y2={swipeVisual.curY}
              stroke={swipeVisual.inRange ? '#4ade80' : '#facc15'}
              strokeWidth="4"
              strokeLinecap="round"
              markerEnd="url(#swipe-arrowhead)"
              opacity="0.9"
            />
          </svg>
        )}

      {/* Bottom-Left Stance Toggle (All camera views use auto-runner) */}
      <div className="bottom-left-cluster">
        <button
          data-ui-interactive="true"
          className={`stance-btn retro-circle-btn ${stance === 'close' ? 'is-close' : 'is-away'}`}
          onClick={onToggleStance}
          aria-label={`Play stance: ${stance}`}
        >
          <span className="stance-btn-title">{stance === 'close' ? 'CLOSE' : 'AWAY'}</span>
          <span className="stance-btn-sub">STANCE</span>
        </button>
      </div>

      <MenuDrawer
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        onResetRally={onResetRally}
        onResetMatch={onResetMatch}
        pointsToWin={hud.pointsToWin}
        cameraViewMode={cameraViewMode}
        onChangeCameraViewMode={onChangeCameraViewMode}
        introStyle={introStyle}
        onChangeIntroStyle={onChangeIntroStyle}
        calibrateMode={calibrateMode}
        onToggleCalibrate={onToggleCalibrate}
        practiceMode={practiceMode}
        onTogglePracticeMode={onTogglePracticeMode}
      />

      <CalibratorPanel
        visible={calibrateMode}
        activeTab={calibrateTab}
        onChangeTab={onChangeCalibrateTab}
        cameraViewMode={cameraViewMode}
        onChangeCameraViewMode={onChangeCameraViewMode}
        viewSettings={viewSettings}
        onChangeViewSettings={onChangeViewSettings}
        offset={courtOffset}
        physicsSpeed={physicsSpeed}
        playerSpeed={playerSpeed}
        onChangeOffset={onChangeOffset}
        onChangePhysicsSpeed={onChangePhysicsSpeed}
        onChangePlayerSpeed={onChangePlayerSpeed}
        saveStatus={saveStatus}
        onSaveNow={onSaveNow}
        onExit={onToggleCalibrate}
      />

      {/* Fullscreen Gate Overlay when not in fullscreen */}
      {!isFullscreen && !fsDismissedUnsupported && (
        <div className="fullscreen-gate" data-ui-interactive="true">
          <div className="fullscreen-gate-card">
            <p className="fullscreen-gate-msg">
              Your screen isn&apos;t full screened. To continue playing, set your screen to full screen
            </p>
            <button
              className="fullscreen-gate-btn"
              onClick={enterFullscreenLandscape}
            >
              Full Screen
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
