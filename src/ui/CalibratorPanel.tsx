import React, { useState } from 'react';
import { CourtOffsetConfig } from '../config/maps';

interface CalibratorPanelProps {
  visible: boolean;
  offset: CourtOffsetConfig;
  fov: number;
  onChangeOffset: (next: CourtOffsetConfig) => void;
  onChangeFov: (fov: number) => void;
  onCopyViewConfig: () => string;
  onExit: () => void;
}

export const CalibratorPanel: React.FC<CalibratorPanelProps> = ({
  visible,
  offset,
  fov,
  onChangeOffset,
  onChangeFov,
  onCopyViewConfig,
  onExit,
}) => {
  const [copied, setCopied] = useState(false);

  if (!visible) return null;

  const updatePos = (axis: 0 | 1 | 2, val: number) => {
    const nextPos: [number, number, number] = [...offset.position];
    nextPos[axis] = val;
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
        <span>Scene Calibrator (Orbit Unlocked)</span>
        <button className="icon-btn" onClick={onExit}>
          ✕
        </button>
      </div>

      <label className="cal-row">
        <span>Pos X ({offset.position[0].toFixed(2)})</span>
        <input
          type="range"
          min={-15}
          max={15}
          step={0.05}
          value={offset.position[0]}
          onChange={(e) => updatePos(0, parseFloat(e.target.value))}
        />
      </label>

      <label className="cal-row">
        <span>Pos Y ({offset.position[1].toFixed(2)})</span>
        <input
          type="range"
          min={-10}
          max={10}
          step={0.05}
          value={offset.position[1]}
          onChange={(e) => updatePos(1, parseFloat(e.target.value))}
        />
      </label>

      <label className="cal-row">
        <span>Pos Z ({offset.position[2].toFixed(2)})</span>
        <input
          type="range"
          min={-15}
          max={15}
          step={0.05}
          value={offset.position[2]}
          onChange={(e) => updatePos(2, parseFloat(e.target.value))}
        />
      </label>

      <label className="cal-row">
        <span>Rot Y ({offset.rotationY.toFixed(2)} rad)</span>
        <input
          type="range"
          min={-3.1416}
          max={3.1416}
          step={0.01}
          value={offset.rotationY}
          onChange={(e) => onChangeOffset({ ...offset, rotationY: parseFloat(e.target.value) })}
        />
      </label>

      <label className="cal-row">
        <span>Scale ({offset.scale.toFixed(2)})</span>
        <input
          type="range"
          min={0.2}
          max={3.0}
          step={0.02}
          value={offset.scale}
          onChange={(e) => onChangeOffset({ ...offset, scale: parseFloat(e.target.value) })}
        />
      </label>

      <label className="cal-row">
        <span>FOV ({fov.toFixed(0)}°)</span>
        <input
          type="range"
          min={25}
          max={80}
          step={1}
          value={fov}
          onChange={(e) => onChangeFov(parseFloat(e.target.value))}
        />
      </label>

      <button className="action-btn primary full" onClick={handleCopy}>
        {copied ? 'Copied JSON to Clipboard!' : 'Copy View Config'}
      </button>
    </div>
  );
};
