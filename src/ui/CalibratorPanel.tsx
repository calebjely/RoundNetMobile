import React, { useState } from 'react';
import { CourtOffsetConfig } from '../config/maps';

export type CalibratorTab = 'camera' | 'net';

interface CalibratorPanelProps {
  visible: boolean;
  activeTab: CalibratorTab;
  onChangeTab: (tab: CalibratorTab) => void;
  offset: CourtOffsetConfig;
  onChangeOffset: (next: CourtOffsetConfig) => void;
  onCopyViewConfig: () => string;
  onExit: () => void;
}

export const CalibratorPanel: React.FC<CalibratorPanelProps> = ({
  visible,
  activeTab,
  onChangeTab,
  offset,
  onChangeOffset,
  onCopyViewConfig,
  onExit,
}) => {
  const [copied, setCopied] = useState(false);

  if (!visible) return null;

  const updateHeight = (val: number) => {
    const nextPos: [number, number, number] = [
      offset.position[0],
      val,
      offset.position[2],
    ];
    onChangeOffset({ ...offset, position: nextPos });
  };

  const handleCopy = async () => {
    const json = onCopyViewConfig();
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      console.log('Calibrator View Config:\n', json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  };

  return (
    <div data-ui-interactive="true" className="calibrator-panel">
      <div className="calibrator-header">
        <span>Scene Calibrator</span>
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
          Net &amp; Scale
        </button>
      </div>

      {activeTab === 'camera' ? (
        <div className="cal-hint">
          Drag: Angle &amp; Orbit · 2-Finger: Pan · Pinch / Scroll: Zoom
        </div>
      ) : (
        <>
          <div className="cal-hint">
            Drag: Placement · Pinch / Scroll: Scale ({offset.scale.toFixed(2)}x)
          </div>
          <label className="cal-row">
            <span>Z-Height ({offset.position[1].toFixed(2)} m)</span>
            <input
              type="range"
              min={-10}
              max={10}
              step={0.02}
              value={offset.position[1]}
              onChange={(e) => updateHeight(parseFloat(e.target.value))}
            />
          </label>
          <label className="cal-row">
            <span>Rotation ({Math.round((offset.rotationY * 180) / Math.PI)}°)</span>
            <input
              type="range"
              min={-Math.PI}
              max={Math.PI}
              step={0.01}
              value={offset.rotationY}
              onChange={(e) =>
                onChangeOffset({ ...offset, rotationY: parseFloat(e.target.value) })
              }
            />
          </label>
          <div className="cal-readout">
            X: {offset.position[0].toFixed(2)} m · Z: {offset.position[2].toFixed(2)} m
          </div>
        </>
      )}

      <button className="action-btn primary full" onClick={handleCopy}>
        {copied ? 'Copied Camera & Placement JSON!' : 'Copy Camera & Placement'}
      </button>
    </div>
  );
};
