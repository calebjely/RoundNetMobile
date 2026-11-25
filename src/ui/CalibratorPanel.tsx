import React from 'react';
import { CourtOffsetConfig } from '../config/maps';

export type CalibratorTab = 'camera' | 'net';

interface CalibratorPanelProps {
  visible: boolean;
  activeTab: CalibratorTab;
  onChangeTab: (tab: CalibratorTab) => void;
  serveSlot: number;
  onChangeServeSlot: (slot: number) => void;
  offset: CourtOffsetConfig;
  physicsSpeed: number;
  playerSpeed: number;
  onChangeOffset: (next: CourtOffsetConfig) => void;
  onChangePhysicsSpeed: (speed: number) => void;
  onChangePlayerSpeed: (speed: number) => void;
  saveStatus: 'idle' | 'saving' | 'saved';
  onSaveNow: () => void;
  onExit: () => void;
}

const SERVE_SLOTS = [
  { idx: 0, label: 'S1' },
  { idx: 1, label: 'S2' },
  { idx: 2, label: 'S3' },
  { idx: 3, label: 'S4' },
];

export const CalibratorPanel: React.FC<CalibratorPanelProps> = ({
  visible,
  activeTab,
  onChangeTab,
  serveSlot,
  onChangeServeSlot,
  offset,
  physicsSpeed,
  playerSpeed,
  onChangeOffset,
  onChangePhysicsSpeed,
  onChangePlayerSpeed,
  saveStatus,
  onSaveNow,
  onExit,
}) => {
  if (!visible) return null;

  const updateHeight = (val: number) => {
    const nextPos: [number, number, number] = [
      offset.position[0],
      val,
      offset.position[2],
    ];
    onChangeOffset({ ...offset, position: nextPos });
  };

  return (
    <div data-ui-interactive="true" className="calibrator-panel">
      <div className="calibrator-header">
        <span>Config</span>
        <button className="icon-btn" onClick={onExit} aria-label="Close calibrator">
          ✕
        </button>
      </div>

      <div className="btn-row">
        <button
          className={`action-btn ${activeTab === 'camera' ? 'active' : ''}`}
          onClick={() => onChangeTab('camera')}
        >
          Camera
        </button>
        <button
          className={`action-btn ${activeTab === 'net' ? 'active' : ''}`}
          onClick={() => onChangeTab('net')}
        >
          Net
        </button>
      </div>

      {activeTab === 'camera' ? (
        <>
          <div className="cal-hint">
            Serve Angle (Drag: Orbit · Pinch: Zoom)
          </div>
          <div className="serve-slot-row">
            {SERVE_SLOTS.map((s) => (
              <button
                key={s.idx}
                className={`slot-btn ${serveSlot === s.idx ? 'active' : ''}`}
                onClick={() => onChangeServeSlot(s.idx)}
              >
                {s.label}
              </button>
            ))}
          </div>

          <div className="v-slider-group">
            <div className="v-slider-col">
              <span className="v-slider-val">{physicsSpeed.toFixed(2)}x</span>
              <input
                className="v-slider"
                type="range"
                min={0.6}
                max={2.0}
                step={0.05}
                value={physicsSpeed}
                onChange={(e) => onChangePhysicsSpeed(parseFloat(e.target.value))}
              />
              <span className="v-slider-lbl">Ball</span>
            </div>

            <div className="v-slider-col">
              <span className="v-slider-val">{playerSpeed.toFixed(2)}x</span>
              <input
                className="v-slider"
                type="range"
                min={0.5}
                max={1.5}
                step={0.05}
                value={playerSpeed}
                onChange={(e) => onChangePlayerSpeed(parseFloat(e.target.value))}
              />
              <span className="v-slider-lbl">Player</span>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="cal-hint">
            Drag: Place · Pinch: Scale ({offset.scale.toFixed(2)}x)
          </div>
          <div className="v-slider-group">
            <div className="v-slider-col">
              <span className="v-slider-val">{offset.position[1].toFixed(2)}m</span>
              <input
                className="v-slider"
                type="range"
                min={-10}
                max={10}
                step={0.02}
                value={offset.position[1]}
                onChange={(e) => updateHeight(parseFloat(e.target.value))}
              />
              <span className="v-slider-lbl">Z-Hgt</span>
            </div>

            <div className="v-slider-col">
              <span className="v-slider-val">
                {Math.round((offset.rotationY * 180) / Math.PI)}°
              </span>
              <input
                className="v-slider"
                type="range"
                min={-Math.PI}
                max={Math.PI}
                step={0.01}
                value={offset.rotationY}
                onChange={(e) =>
                  onChangeOffset({ ...offset, rotationY: parseFloat(e.target.value) })
                }
              />
              <span className="v-slider-lbl">Rot</span>
            </div>

            <div className="v-slider-col">
              <span className="v-slider-val">{physicsSpeed.toFixed(2)}x</span>
              <input
                className="v-slider"
                type="range"
                min={0.6}
                max={2.0}
                step={0.05}
                value={physicsSpeed}
                onChange={(e) => onChangePhysicsSpeed(parseFloat(e.target.value))}
              />
              <span className="v-slider-lbl">Ball</span>
            </div>

            <div className="v-slider-col">
              <span className="v-slider-val">{playerSpeed.toFixed(2)}x</span>
              <input
                className="v-slider"
                type="range"
                min={0.5}
                max={1.5}
                step={0.05}
                value={playerSpeed}
                onChange={(e) => onChangePlayerSpeed(parseFloat(e.target.value))}
              />
              <span className="v-slider-lbl">Player</span>
            </div>
          </div>
        </>
      )}

      <button className="action-btn primary full" onClick={onSaveNow}>
        {saveStatus === 'saving'
          ? 'Saving...'
          : saveStatus === 'saved'
            ? 'Saved ✓'
            : 'Save Config'}
      </button>
    </div>
  );
};
