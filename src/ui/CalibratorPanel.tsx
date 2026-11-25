import React from 'react';
import {
  CameraViewMode,
  CameraViewSettings,
  CourtOffsetConfig,
} from '../config/maps';

export type CalibratorTab = 'camera' | 'net';

interface CalibratorPanelProps {
  visible: boolean;
  activeTab: CalibratorTab;
  onChangeTab: (tab: CalibratorTab) => void;
  cameraViewMode: CameraViewMode;
  onChangeCameraViewMode: (mode: CameraViewMode) => void;
  viewSettings: CameraViewSettings;
  onChangeViewSettings: (next: CameraViewSettings) => void;
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

const VIEW_MODES: { id: CameraViewMode; label: string }[] = [
  { id: 'pressbox', label: 'Press Box' },
  { id: 'follow_behind', label: 'Follow' },
  { id: 'first_person', label: '1st Person' },
];

export const CalibratorPanel: React.FC<CalibratorPanelProps> = ({
  visible,
  activeTab,
  onChangeTab,
  cameraViewMode,
  onChangeCameraViewMode,
  viewSettings,
  onChangeViewSettings,
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
            {cameraViewMode === 'pressbox'
              ? 'Press Box (Drag: Angle · Slider: Zoom)'
              : cameraViewMode === 'follow_behind'
                ? 'Follow Behind (Applies to All Players)'
                : '1st Person POV (Applies to All Players)'}
          </div>
          <div className="serve-slot-row">
            {VIEW_MODES.map((m) => (
              <button
                key={m.id}
                className={`slot-btn ${cameraViewMode === m.id ? 'active' : ''}`}
                onClick={() => onChangeCameraViewMode(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>

          <div className="v-slider-group">
            {cameraViewMode === 'pressbox' && (
              <div className="v-slider-col">
                <span className="v-slider-val">{viewSettings.pressboxZoom.toFixed(2)}x</span>
                <input
                  className="v-slider"
                  type="range"
                  min={0.5}
                  max={2.0}
                  step={0.05}
                  value={viewSettings.pressboxZoom}
                  onChange={(e) =>
                    onChangeViewSettings({
                      ...viewSettings,
                      pressboxZoom: parseFloat(e.target.value),
                    })
                  }
                />
                <span className="v-slider-lbl">Zoom</span>
              </div>
            )}

            {cameraViewMode === 'follow_behind' && (
              <>
                <div className="v-slider-col">
                  <span className="v-slider-val">
                    {viewSettings.followBehindDist.toFixed(1)}m
                  </span>
                  <input
                    className="v-slider"
                    type="range"
                    min={1.5}
                    max={5.5}
                    step={0.1}
                    value={viewSettings.followBehindDist}
                    onChange={(e) =>
                      onChangeViewSettings({
                        ...viewSettings,
                        followBehindDist: parseFloat(e.target.value),
                      })
                    }
                  />
                  <span className="v-slider-lbl">Dist</span>
                </div>

                <div className="v-slider-col">
                  <span className="v-slider-val">
                    {viewSettings.followBehindHeight.toFixed(2)}m
                  </span>
                  <input
                    className="v-slider"
                    type="range"
                    min={1.3}
                    max={3.8}
                    step={0.05}
                    value={viewSettings.followBehindHeight}
                    onChange={(e) =>
                      onChangeViewSettings({
                        ...viewSettings,
                        followBehindHeight: parseFloat(e.target.value),
                      })
                    }
                  />
                  <span className="v-slider-lbl">Hgt</span>
                </div>
              </>
            )}

            {cameraViewMode === 'first_person' && (
              <>
                <div className="v-slider-col">
                  <span className="v-slider-val">{viewSettings.fpEyeHeight.toFixed(2)}m</span>
                  <input
                    className="v-slider"
                    type="range"
                    min={1.45}
                    max={1.9}
                    step={0.02}
                    value={viewSettings.fpEyeHeight}
                    onChange={(e) =>
                      onChangeViewSettings({
                        ...viewSettings,
                        fpEyeHeight: parseFloat(e.target.value),
                      })
                    }
                  />
                  <span className="v-slider-lbl">Eye</span>
                </div>

                <div className="v-slider-col">
                  <span className="v-slider-val">{Math.round(viewSettings.fpFov)}°</span>
                  <input
                    className="v-slider"
                    type="range"
                    min={52}
                    max={90}
                    step={1}
                    value={viewSettings.fpFov}
                    onChange={(e) =>
                      onChangeViewSettings({
                        ...viewSettings,
                        fpFov: parseFloat(e.target.value),
                      })
                    }
                  />
                  <span className="v-slider-lbl">FOV</span>
                </div>
              </>
            )}

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
