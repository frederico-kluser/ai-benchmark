/**
 * Brain Visualization library.
 *
 * Drop-in 3D neural-network brain visualization for React.
 */

export { BrainVisualization } from './components/organisms/BrainVisualization';
export type { BrainVisualizationProps } from './components/organisms/BrainVisualization';

export { BrainCanvas } from './components/molecules/BrainCanvas';
export type { BrainCanvasProps } from './components/molecules/BrainCanvas';

export { BrainCanvasElement } from './components/atoms/BrainCanvasElement';
export type { BrainCanvasElementProps } from './components/atoms/BrainCanvasElement';

export { GlowBackdrop } from './components/atoms/GlowBackdrop';
export type { GlowBackdropProps } from './components/atoms/GlowBackdrop';

export { useBrainAnimation } from './hooks/use-brain-animation';
export { useDragRotation } from './hooks/use-drag-rotation';
export { useBrainState } from './hooks/use-brain-state';
export type { UseBrainStateOptions, UseBrainStateResult } from './hooks/use-brain-state';

export type {
  Point3D,
  Neuron,
  PropagationWave,
  ProjectedNeuron,
  RotationAngles,
  DragRotationOffset,
  AnimationPhaseState,
  AnimationPhaseResult,
  WaveIdCounter,
  RotationConfig,
  BrainState,
  BrainStateActions,
} from './types';

export { NeuralActivityLevel, BrainVisibilityState } from './types';

export {
  NETWORK_TOPOLOGY,
  BRAIN_SHAPE,
  ANIMATION_TIMING,
  DRAG_ROTATION,
  EXPLOSION,
  WAVE_PROPAGATION,
  MUTABLE_WAVE_PROPAGATION,
  RENDERING,
  COLORS,
  OPACITY,
  LINE_WIDTHS,
} from './constants';

export {
  calculateRotationAngles,
  calculateAnimationPhase,
  updateNeuronPositions,
  spawnDualHemisphereWaves,
  updateWavePropagation,
  reducePropagationProbabilityByHalf,
  resetPropagationProbability,
  setPropagationProbability,
  getCurrentPropagationProbability,
} from './core/brain-physics';
