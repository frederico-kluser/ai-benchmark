/**
 * Core type definitions for the Brain Visualization.
 *
 * Defines all interfaces and enums used throughout the neural network
 * visualization system, including 3D geometry, neuron state, and wave
 * propagation types.
 */

/**
 * Represents a point in 3D Cartesian space (immutable).
 */
export interface Point3D {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Mutable version of Point3D for animation state.
 */
export interface MutablePoint3D {
  x: number;
  y: number;
  z: number;
}

/**
 * Represents a single neuron in the neural network visualization.
 */
export interface Neuron {
  /** Unique identifier for this neuron (0-indexed) */
  readonly id: number;
  /** Target position when the brain is fully formed */
  readonly basePosition: Point3D;
  /** Current interpolated position during animation (mutable for performance) */
  currentPosition: MutablePoint3D;
  /** Normalized direction vector for explosion animation */
  readonly explosionDirection: Point3D;
  /**
   * Delay factor (0.0-1.0) determining when this neuron begins moving during
   * implosion animation. Higher values = later start.
   */
  readonly suctionDelayFactor: number;
  /** Current velocity vector (reserved for future physics, mutable) */
  velocity: MutablePoint3D;
  /** Array of connected neuron IDs */
  readonly connectionIds: number[];
  /** Timestamp (ms) of the most recent wave activation */
  lastActivationTimestamp: number;
}

/**
 * Represents a BFS wave propagating through the neural network.
 */
export interface PropagationWave {
  readonly id: number;
  activeFrontIds: number[];
  readonly visitedIds: Set<number>;
  nextPropagationTimestamp: number;
}

/**
 * Controls the frequency of synapse wave generation.
 */
export enum NeuralActivityLevel {
  LOW = 'LOW',
  HIGH = 'HIGH',
}

/**
 * Controls the visual state of the brain structure.
 */
export enum BrainVisibilityState {
  DISPERSED = 'DISPERSED',
  ASSEMBLED = 'ASSEMBLED',
}

/**
 * Data for a neuron after 3D-to-2D projection.
 */
export interface ProjectedNeuron {
  readonly screenX: number;
  readonly screenY: number;
  readonly perspectiveScale: number;
  readonly depth: number;
  readonly isGlowing: boolean;
  readonly waveActivationAlpha: number;
}

/**
 * Current rotation angles for the brain's continuous rotation.
 */
export interface RotationAngles {
  readonly x: number;
  readonly y: number;
}

/**
 * Mutable rotation offset from user drag interaction.
 */
export interface DragRotationOffset {
  x: number;
  y: number;
}

/**
 * State for managing animation phases (formation/dispersion).
 */
export interface AnimationPhaseState {
  startTimestamp: number;
  startPhase: number;
  targetPhase: number;
  isAnimating: boolean;
}

/**
 * Result of calculating the current animation phase.
 */
export interface AnimationPhaseResult {
  readonly phase: number;
  readonly isComplete: boolean;
}

/**
 * Mutable reference container for wave ID generation.
 */
export interface WaveIdCounter {
  current: number;
}

/**
 * Configuration for the brain auto-rotation behavior.
 */
export interface RotationConfig {
  enabled?: boolean;
  ySpeed?: number;
  xAmplitude?: number;
  xFrequency?: number;
}

/**
 * Consolidated state exposed by useBrainState.
 */
export interface BrainState {
  activityLevel: NeuralActivityLevel;
  visibilityState: BrainVisibilityState;
  glowEnabled: boolean;
  propagationProbability: number;
}

/**
 * Callbacks for mutating BrainState.
 */
export interface BrainStateActions {
  toggleActivity: () => void;
  setActivityLevel: (level: NeuralActivityLevel) => void;
  toggleVisibility: () => void;
  setVisibilityState: (state: BrainVisibilityState) => void;
  toggleGlow: () => void;
  setPropagation: (probability: number) => void;
}
