import React, { useState } from 'react';
import { CourtOffsetConfig, IntroCameraStyle } from '../config/maps';
import { JoystickVisualState } from '../engine/InputManager';
import { MatchHUDState, TimingPopup } from '../engine/MatchManager';
import { FirstPersonHints, OffscreenLandingHint } from '../engine/SceneManager';
import { CalibratorPanel, CalibratorTab } from './CalibratorPanel';
import { MenuDrawer } from './MenuDrawer';

interface GameHUDProps {
  hud: MatchHUDState;
  joystick: JoystickVisualState;
  popups: TimingPopup[];
  offscreenLanding: OffscreenLandingHint;
  fpHints: FirstPersonHints;
  hitTimingBar: { visible: boolean; value: number };
  isHumanBlocking: boolean;
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
  playerSpeed: number;
  onChangeOffset: (next: CourtOffsetConfig) => void;
  onChangePhysicsSpeed: (speed: number) => void;
  onChangePlayerSpeed: (speed: number) => void;
  saveStatus: 'idle' | 'saving' | 'saved';
  onSaveNow: () => void;
}

export const GameHUD: React.FC<GameHUDProps> = ({
  hud,
  joystick,
  popups,
  offscreenLanding,
  fpHints,
  hitTimingBar,
  isHumanBlocking,
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
  playerSpeed,
  onChangeOffset,
  onChangePhysicsSpeed,
  onChangePlayerSpeed,
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

      {/* Top Right Retro 3D Circular Menu Button */}
      <button
        data-ui-interactive="true"
        className="menu-btn retro-circle-btn"
        onClick={() => setMenuOpen(true)}
        aria-label="Menu"
      >
        <span className="circle-btn-icon">☰</span>
      </button>

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
          <div className="timing-tri-bar">
            <div className="tri-yellow" />
            <div className="tri-green" />
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

      {/* 1st-Person Edge Indicators: Net & Partner */}
      {cameraViewMode === 'first_person' && fpHints.netEdge.visible && (
        <div
          className="fp-edge-badge net-edge"
          style={{
            left: fpHints.netEdge.screenX,
            top: fpHints.netEdge.screenY,
          }}
        >
          <span>NET</span>
          <span
            className="fp-edge-arrow"
            style={{ transform: `rotate(${fpHints.netEdge.angleDeg}deg)` }}
          >
            ➤
          </span>
        </div>
      )}

      {cameraViewMode === 'first_person' && fpHints.partnerEdge.visible && (
        <div
          className="fp-edge-badge partner-edge"
          style={{
            left: fpHints.partnerEdge.screenX,
            top: fpHints.partnerEdge.screenY,
          }}
        >
          <span>PARTNER</span>
          <span
            className="fp-edge-arrow"
            style={{ transform: `rotate(${fpHints.partnerEdge.angleDeg}deg)` }}
          >
            ➤
          </span>
        </div>
      )}

      {/* Ball-Approach Hit Timing Bar (Red / Yellow / Green) */}
      {hitTimingBar.visible && !hud.serveMeterActive && (
        <div className="hit-timing-wrap">
          <div className="hit-timing-label">SWIPE TO HIT</div>
          <div className="timing-tri-bar">
            <div className="tri-yellow" />
            <div className="tri-green" />
            <div
              className="serve-meter-cursor"
              style={{ left: `${hitTimingBar.value * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* Bottom-Left Persistent 3D Arcade Cluster (Press-Box mode only) */}
      {cameraViewMode === 'pressbox' && (
        <div className="bottom-left-cluster">
          <button
            data-ui-interactive="true"
            className={`return-net-btn retro-circle-btn ${returnToNetActive ? 'active' : ''}`}
            onPointerDown={() => onReturnToNetPress(true)}
            onPointerUp={() => onReturnToNetPress(false)}
            onPointerCancel={() => onReturnToNetPress(false)}
            aria-label="Move to net"
          >
            <span className="circle-btn-icon">◎</span>
          </button>

          <div id="persistent-joystick-base" className="joystick-base-3d">
            <div className="joystick-walk-ring" />
            <div
              className={`joystick-thumb-3d ${joystick.isSprint ? 'sprint' : ''}`}
              style={{
                transform: joystick.active
                  ? `translate(${joystick.thumbX - joystick.originX}px, ${joystick.thumbY - joystick.originY}px)`
                  : 'translate(0px, 0px)',
              }}
            />
          </div>
        </div>
      )}

      {/* Subtle Touch Hint on Bottom Right */}
      <div className="right-zone-hint">
        {cameraViewMode === 'first_person'
          ? 'Swipe Anywhere: Up = Set · Cut/Down = Hit Net · Hold = Block'
          : 'Swipe: Hit / Set / Spike · Hold: Block'}
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
        playerSpeed={playerSpeed}
        onChangeOffset={onChangeOffset}
        onChangePhysicsSpeed={onChangePhysicsSpeed}
        onChangePlayerSpeed={onChangePlayerSpeed}
        saveStatus={saveStatus}
        onSaveNow={onSaveNow}
        onExit={onToggleCalibrate}
      />
    </div>
  );
};
