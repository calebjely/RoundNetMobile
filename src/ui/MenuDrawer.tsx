import React from 'react';
import { RULES_QUICK_REFERENCE } from '../config/rules';

interface MenuDrawerProps {
  open: boolean;
  onClose: () => void;
  onResetRally: () => void;
  onResetMatch: (pointsToWin: 15 | 21) => void;
  pointsToWin: 15 | 21;
  cameraViewMode: 'pressbox' | 'first_person';
  onChangeCameraViewMode: (mode: 'pressbox' | 'first_person') => void;
  calibrateMode: boolean;
  onToggleCalibrate: () => void;
}

export const MenuDrawer: React.FC<MenuDrawerProps> = ({
  open,
  onClose,
  onResetRally,
  onResetMatch,
  pointsToWin,
  cameraViewMode,
  onChangeCameraViewMode,
  calibrateMode,
  onToggleCalibrate,
}) => {
  if (!open) return null;

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
              Press-Box View
            </button>
            <button
              className={`action-btn ${cameraViewMode === 'first_person' ? 'active' : ''}`}
              onClick={() => {
                onChangeCameraViewMode('first_person');
                onClose();
              }}
            >
              1st Person View
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
        </div>

        <div className="drawer-section">
          <h3>Touch Controls</h3>
          <ul className="controls-list">
            <li>
              <strong>Left Thumb Joystick:</strong> Inner ring (0–55%) = Walk · Outer ring (55–100%) = Sprint (drains Stamina)
            </li>
            <li>
              <strong>Return to Net Button:</strong> Auto-sprints to defensive net spacing (~2.5 m)
            </li>
            <li>
              <strong>Right Swipe Up:</strong> Toss Serve · Set (Touches 1–2) · Rainbow/Drop Shot (Touch 3)
            </li>
            <li>
              <strong>Right Swipe Down:</strong> Overhead Spike (near net) · Fast Drive Serve
            </li>
            <li>
              <strong>Right Tap &amp; Hold:</strong> Raised-Arms Block at Net
            </li>
            <li>
              <strong>Auto-Dive:</strong> Sprint toward a low falling ball + Right Swipe
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
