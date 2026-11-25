import React, { useState } from 'react';
import { CourtOffsetConfig, IntroCameraStyle } from '../config/maps';
import { JoystickVisualState } from '../engine/InputManager';
import { MatchHUDState, TimingPopup } from '../engine/MatchManager';
import { OffscreenLandingHint } from '../engine/SceneManager';
import { CalibratorPanel, CalibratorTab } from './CalibratorPanel';
import { MenuDrawer } from './MenuDrawer';

interface GameHUDProps {
  hud: MatchHUDState;
  joystick: JoystickVisualState;
  popups: TimingPopup[];
  offscreenLanding: OffscreenLandingHint;
  returnToNetActive: boolean;
  onReturnToNetPress: (active: boolean) => void;
  onResetRally: () => void;
  onResetMatch: (pointsToWin: 15 | 21) => void;
  calibrateMode: boolean;
  calibrateTab: CalibratorTab;
  calibrateServeSlot: number;
  onChangeCalibrateTab: (tab: CalibratorTab) => void;
  onChangeCalibrateServeSlot: (slot: number) => void;
  onToggleCalibrate: () => void;
  cameraViewMode: 'pressbox' | 'first_person';
  onChangeCameraViewMode: (mode: 'pressbox' | 'first_person') => void;
  introStyle: IntroCameraStyle;
  onChangeIntroStyle: (style: IntroCameraStyle) => void;
  courtOffset: CourtOffsetConfig;
  physicsSpeed: number;
  onChangeOffset: (next: CourtOffsetConfig) => void;
  onChangePhysicsSpeed: (speed: number) => void;
  saveStatus: 'idle' | 'saving' | 'saved';
  onSaveNow: () => void;
}

export const GameHUD: React.FC<GameHUDProps> = ({
  hud,
  joystick,
  popups,
  offscreenLanding,
  returnToNetActive,
  onReturnToNetPress,
  onResetRally,
  onResetMatch,
  calibrateMode,
  calibrateTab,
  calibrateServeSlot,
  onChangeCalibrateTab,
  onChangeCalibrateServeSlot,
  onToggleCalibrate,
  cameraViewMode,
  onChangeCameraViewMode,
  introStyle,
  onChangeIntroStyle,
  courtOffset,
  physicsSpeed,
  onChangeOffset,
  onChangePhysicsSpeed,
  saveStatus,
  onSaveNow,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="hud-root">
      {/* Non-blocking Portrait Orientation Hint */}
      <div className="portrait-hint">
        Rotate to Landscape for Best Controls
      </div>

      {/* Top Center Scoreboard */}
      <div className="scoreboard" data-ui-interactive="true">
        <div className={`team-box team-a ${hud.servingTeam === 'A' ? 'serving' : ''}`}>
          <span className="team-label">BLUE</span>
          <span className="team-score">{hud.scoreA}</span>
        </div>

        <div className="match-meta">
          <div className="meta-row">
            <span className="badge server-badge">
              {hud.serverName} · {hud.serveAttempt === 1 ? '1st' : '2nd'} Serve
            </span>
          </div>
          <div className="meta-row">
            {hud.phase === 'RALLY_LIVE' || hud.phase === 'SERVE_IN_FLIGHT' ? (
              <span
                className={`touch-counter team-ball-${hud.possessionTeam.toLowerCase()}`}
              >
                {hud.possessionTeam === 'A' ? 'BLUE BALL' : 'ORANGE BALL'} · HIT{' '}
                {Math.min(3, hud.teamTouches + 1)}/3
                {hud.isFirstPossessionAfterServe ? ' (3 req)' : ''}
              </span>
            ) : (
              <span className="touch-counter">
                {hud.isHumanServing ? 'Swipe Up on Right to Toss' : 'Ready'}
              </span>
            )}
          </div>
        </div>

        <div className={`team-box team-b ${hud.servingTeam === 'B' ? 'serving' : ''}`}>
          <span className="team-score">{hud.scoreB}</span>
          <span className="team-label">ORANGE</span>
        </div>
      </div>

      {/* Top Right Circular Gaming Menu Button */}
      <button
        data-ui-interactive="true"
        className="menu-btn game-circle-btn"
        onClick={() => setMenuOpen(true)}
        aria-label="Menu"
      >
        <span className="circle-btn-icon">☰</span>
      </button>

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

      {/* Bottom-Left Circular Gaming Button: Return to Net */}
      <div className="bottom-left-cluster">
        <button
          data-ui-interactive="true"
          className={`return-net-btn game-circle-btn ${returnToNetActive ? 'active' : ''}`}
          onPointerDown={() => onReturnToNetPress(true)}
          onPointerUp={() => onReturnToNetPress(false)}
          onPointerCancel={() => onReturnToNetPress(false)}
        >
          <span className="circle-btn-icon">◎</span>
          <span className="circle-btn-label">NET</span>
        </button>
      </div>

      {/* Progressive Dual-Ring Virtual Joystick Visual */}
      {joystick.active && (
        <div
          className="joystick-base"
          style={{ left: joystick.originX, top: joystick.originY }}
        >
          <div className="joystick-walk-ring" />
          <div
            className={`joystick-thumb ${joystick.isSprint ? 'sprint' : ''}`}
            style={{
              transform: `translate(${joystick.thumbX - joystick.originX}px, ${joystick.thumbY - joystick.originY}px)`,
            }}
          />
        </div>
      )}

      {/* Subtle Touch Hint on Bottom Right */}
      <div className="right-zone-hint">
        Swipe: Hit / Set / Spike · Hold: Block
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
      />

      <CalibratorPanel
        visible={calibrateMode}
        activeTab={calibrateTab}
        onChangeTab={onChangeCalibrateTab}
        serveSlot={calibrateServeSlot}
        onChangeServeSlot={onChangeCalibrateServeSlot}
        offset={courtOffset}
        physicsSpeed={physicsSpeed}
        onChangeOffset={onChangeOffset}
        onChangePhysicsSpeed={onChangePhysicsSpeed}
        saveStatus={saveStatus}
        onSaveNow={onSaveNow}
        onExit={onToggleCalibrate}
      />
    </div>
  );
};
