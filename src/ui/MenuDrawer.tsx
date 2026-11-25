import React from 'react';
import { CameraViewMode, IntroCameraStyle } from '../config/maps';
import { RULES_QUICK_REFERENCE } from '../config/rules';

interface MenuDrawerProps {
  open: boolean;
  onClose: () => void;
  onResetRally: () => void;
  onResetMatch: (pointsToWin: 15 | 21) => void;
  pointsToWin: 15 | 21;
  cameraViewMode: CameraViewMode;
  onChangeCameraViewMode: (mode: CameraViewMode) => void;
  introStyle: IntroCameraStyle;
  onChangeIntroStyle: (style: IntroCameraStyle) => void;
  calibrateMode: boolean;
  onToggleCalibrate: () => void;
}

const INTRO_OPTIONS: { id: IntroCameraStyle; label: string }[] = [
  { id: 'swoop90', label: '90° Swoop' },
  { id: 'wide_zoom_tilt', label: 'Wide → Tilt' },
  { id: 'glide180', label: '180° Glide' },
  { id: 'low_flyover', label: 'Low Skim' },
];

export const MenuDrawer: React.FC<MenuDrawerProps> = ({
  open,
  onClose,
  onResetRally,
  onResetMatch,
  pointsToWin,
  cameraViewMode,
  onChangeCameraViewMode,
  introStyle,
  onChangeIntroStyle,
  calibrateMode,
  onToggleCalibrate,
}) => {
  if (!open) return null;

  const handleFullscreenLandscape = async () => {
    try {
      const el = document.documentElement as HTMLElement & {
        webkitRequestFullscreen?: () => Promise<void>;
      };
      if (!document.fullscreenElement) {
        if (el.requestFullscreen) await el.requestFullscreen();
        else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
      } else {
        await document.exitFullscreen?.();
      }
      const orient = screen.orientation as ScreenOrientation & {
        lock?: (o: string) => Promise<void>;
      };
      if (orient?.lock) {
        await orient.lock('landscape').catch(() => {});
      }
    } catch {
      // ignore if unsupported on iOS Safari
    }
    onClose();
  };

  return (
    <div
      data-ui-interactive="true"
      className="drawer-backdrop"
      onClick={onClose}
    >
      <div className="drawer-panel" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-header">
          <h2>RoundNetMobile <span className="version-tag">v{__APP_VERSION__}</span></h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close menu">
            ✕
          </button>
        </div>

        <div className="drawer-section">
          <h3>Match Controls</h3>
          <div className="btn-row">
            <button
              className="action-btn"
              onClick={() => {
                onResetRally();
                onClose();
              }}
            >
              Reset Rally
            </button>
            <button
              className="action-btn primary"
              onClick={() => {
                onResetMatch(pointsToWin);
                onClose();
              }}
            >
              Reset Match
            </button>
          </div>

          <div className="btn-row" style={{ marginTop: 8 }}>
            <button
              className={`action-btn ${pointsToWin === 15 ? 'active' : ''}`}
              onClick={() => onResetMatch(15)}
            >
              Play to 15
            </button>
            <button
              className={`action-btn ${pointsToWin === 21 ? 'active' : ''}`}
              onClick={() => onResetMatch(21)}
            >
              Play to 21
            </button>
          </div>

          <div className="btn-row" style={{ marginTop: 8 }}>
            <button
              className={`action-btn ${cameraViewMode === 'pressbox' ? 'active' : ''}`}
              onClick={() => {
                onChangeCameraViewMode('pressbox');
                onClose();
              }}
            >
              Press Box
            </button>
            <button
              className={`action-btn ${cameraViewMode === 'follow_behind' ? 'active' : ''}`}
              onClick={() => {
                onChangeCameraViewMode('follow_behind');
                onClose();
              }}
            >
              Follow Behind
            </button>
            <button
              className={`action-btn ${cameraViewMode === 'first_person' ? 'active' : ''}`}
              onClick={() => {
                onChangeCameraViewMode('first_person');
                onClose();
              }}
            >
              1st Person
            </button>
          </div>

          <button
            className={`action-btn full ${calibrateMode ? 'active' : ''}`}
            style={{ marginTop: 8 }}
            onClick={() => {
              onToggleCalibrate();
              onClose();
            }}
          >
            {calibrateMode ? 'Exit Scene Calibrator (F2)' : 'Toggle Scene Calibrator (F2)'}
          </button>

          <button
            className="action-btn primary full"
            style={{ marginTop: 8 }}
            onClick={handleFullscreenLandscape}
          >
            Fullscreen (Landscape)
          </button>
        </div>

        <div className="drawer-section">
          <h3>Start Camera Intro</h3>
          <div className="intro-grid">
            {INTRO_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                className={`action-btn ${introStyle === opt.id ? 'active' : ''}`}
                onClick={() => {
                  onChangeIntroStyle(opt.id);
                  onClose();
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="drawer-section">
          <h3>Touch Controls</h3>
          <ul className="controls-list">
            <li>
              <strong>Auto-Runner + Stance:</strong> Your player runs automatically in every view. Tap <strong>CLOSE / AWAY</strong> to play tighter or deeper.
            </li>
            <li>
              <strong>Touch &amp; Swipe Direction:</strong> Touch the ball when <strong>IN RANGE</strong> (green ring) and swipe in the direction you want to hit.
            </li>
            <li>
              <strong>Swipe Up (±45°):</strong> Toss Serve · Set forward to partner (Touches 1–2) · High Lob (Touch 3)
            </li>
            <li>
              <strong>Sideways / Down Swipe:</strong> Side-to-side = Low Cut · Downward = Steep Spike
            </li>
            <li>
              <strong>Tap &amp; Hold:</strong> Raised-Arms Block at Net
            </li>
          </ul>
        </div>

        <div className="drawer-section">
          <h3>IRF July 2026 Rules</h3>
          <ul className="rules-list">
            {RULES_QUICK_REFERENCE.map((rule, i) => (
              <li key={i}>{rule}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
};
