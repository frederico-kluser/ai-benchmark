/**
 * Brain Physics Engine.
 *
 * Handles rotation updates, animation phases, neuron interpolation, and wave
 * propagation through the network.
 */

import type {
  Neuron,
  PropagationWave,
  RotationAngles,
  DragRotationOffset,
  AnimationPhaseResult,
  WaveIdCounter,
  RotationConfig,
} from '../types';
import {
  ANIMATION_TIMING,
  EXPLOSION,
  WAVE_PROPAGATION,
  MUTABLE_WAVE_PROPAGATION,
} from '../constants';

function resolveRotationConfig(config?: RotationConfig): {
  enabled: boolean;
  ySpeed: number;
  xAmplitude: number;
  xFrequency: number;
} {
  return {
    enabled: config?.enabled ?? true,
    ySpeed: config?.ySpeed ?? ANIMATION_TIMING.Y_ROTATION_SPEED,
    xAmplitude: config?.xAmplitude ?? ANIMATION_TIMING.X_OSCILLATION_AMPLITUDE,
    xFrequency: config?.xFrequency ?? ANIMATION_TIMING.X_OSCILLATION_FREQUENCY,
  };
}

export function calculateRotationAngles(
  timeConstant: number,
  dragOffset?: DragRotationOffset,
  isDragging?: boolean,
  rotationConfig?: RotationConfig
): RotationAngles {
  const { enabled, ySpeed, xAmplitude, xFrequency } = resolveRotationConfig(rotationConfig);

  const autoY = enabled ? timeConstant * ySpeed : 0;
  const autoX = enabled ? Math.sin(timeConstant * xFrequency) * xAmplitude : 0;

  if (!dragOffset) {
    return { y: autoY, x: autoX };
  }

  if (isDragging) {
    return {
      y: dragOffset.y,
      x: dragOffset.x,
    };
  }

  return {
    y: autoY + dragOffset.y,
    x: autoX + dragOffset.x,
  };
}

export function calculateAnimationPhase(
  animationStartTime: number,
  animationDuration: number,
  startPhaseValue: number,
  targetPhaseValue: number,
  currentTimestamp: number
): AnimationPhaseResult {
  const elapsedTime = currentTimestamp - animationStartTime;
  const linearProgress = Math.min(elapsedTime / animationDuration, 1);

  let currentPhase = startPhaseValue;

  if (targetPhaseValue === 2) {
    currentPhase = linearProgress * 2;
  } else {
    const splitPoint = ANIMATION_TIMING.FORMATION_SPLIT_RATIO;

    if (linearProgress < splitPoint) {
      const implosionProgress = linearProgress / splitPoint;
      currentPhase = 2 - implosionProgress;
    } else {
      const formationProgress = (linearProgress - splitPoint) / (1 - splitPoint);
      currentPhase = 1 - formationProgress;
    }
  }

  return {
    phase: currentPhase,
    isComplete: linearProgress >= 1,
  };
}

function calculateImplosionEase(globalPhase: number, suctionDelayFactor: number): number {
  const adjustedProgress = Math.max(
    0,
    (globalPhase - suctionDelayFactor) / (1 - suctionDelayFactor)
  );
  return adjustedProgress * adjustedProgress;
}

function calculateExplosionEase(explosionPhase: number): number {
  return 1 - Math.pow(1 - explosionPhase, EXPLOSION.EASING_POWER);
}

export function updateNeuronPositions(neurons: Neuron[], currentPhase: number): void {
  for (const neuron of neurons) {
    let positionX = 0;
    let positionY = 0;
    let positionZ = 0;

    if (currentPhase <= 1) {
      const implosionEase = calculateImplosionEase(currentPhase, neuron.suctionDelayFactor);
      const formationFactor = 1 - implosionEase;

      positionX = neuron.basePosition.x * formationFactor;
      positionY = neuron.basePosition.y * formationFactor;
      positionZ = neuron.basePosition.z * formationFactor;
    } else {
      const explosionProgress = currentPhase - 1;
      const explosionEase = calculateExplosionEase(explosionProgress);
      const explosionDistance = EXPLOSION.MAX_RADIUS * explosionEase;

      positionX = neuron.explosionDirection.x * explosionDistance;
      positionY = neuron.explosionDirection.y * explosionDistance;
      positionZ = neuron.explosionDirection.z * explosionDistance;
    }

    neuron.currentPosition.x = positionX;
    neuron.currentPosition.y = positionY;
    neuron.currentPosition.z = positionZ;
  }
}

function filterNeuronsByHemisphere(neurons: Neuron[], isLeftHemisphere: boolean): Neuron[] {
  const threshold = MUTABLE_WAVE_PROPAGATION.HEMISPHERE_THRESHOLD;

  return neurons.filter((neuron) =>
    isLeftHemisphere
      ? neuron.basePosition.x < -threshold
      : neuron.basePosition.x > threshold
  );
}

function selectRandomNeuron(neurons: Neuron[]): Neuron | undefined {
  if (neurons.length === 0) return undefined;
  const randomIndex = Math.floor(Math.random() * neurons.length);
  return neurons[randomIndex];
}

function createWave(
  startNeuron: Neuron,
  waveId: number,
  currentTimestamp: number
): PropagationWave {
  return {
    id: waveId,
    activeFrontIds: [startNeuron.id],
    visitedIds: new Set([startNeuron.id]),
    nextPropagationTimestamp: currentTimestamp,
  };
}

export function spawnDualHemisphereWaves(
  neurons: Neuron[],
  activeWaves: PropagationWave[],
  waveIdCounter: WaveIdCounter,
  currentTimestamp: number
): void {
  const leftHemisphereNeurons = filterNeuronsByHemisphere(neurons, true);
  const rightHemisphereNeurons = filterNeuronsByHemisphere(neurons, false);

  const leftStartNeuron = selectRandomNeuron(leftHemisphereNeurons);
  const rightStartNeuron = selectRandomNeuron(rightHemisphereNeurons);

  if (!leftStartNeuron || !rightStartNeuron) return;

  const leftWave = createWave(leftStartNeuron, waveIdCounter.current++, currentTimestamp);
  activeWaves.push(leftWave);
  leftStartNeuron.lastActivationTimestamp = currentTimestamp;

  const rightWave = createWave(rightStartNeuron, waveIdCounter.current++, currentTimestamp);
  activeWaves.push(rightWave);
  rightStartNeuron.lastActivationTimestamp = currentTimestamp;
}

function propagateWaveStep(
  wave: PropagationWave,
  neurons: Neuron[],
  currentTimestamp: number
): boolean {
  const nextFrontIds: number[] = [];

  for (const parentNeuronId of wave.activeFrontIds) {
    const parentNeuron = neurons[parentNeuronId];
    if (!parentNeuron) continue;

    for (const neighborId of parentNeuron.connectionIds) {
      if (!wave.visitedIds.has(neighborId)) {
        if (Math.random() < MUTABLE_WAVE_PROPAGATION.PROPAGATION_PROBABILITY) {
          wave.visitedIds.add(neighborId);
          nextFrontIds.push(neighborId);

          const neighborNeuron = neurons[neighborId];
          if (neighborNeuron) {
            neighborNeuron.lastActivationTimestamp = currentTimestamp;
          }
        }
      }
    }
  }

  if (nextFrontIds.length > 0) {
    wave.activeFrontIds = nextFrontIds;
    wave.nextPropagationTimestamp = currentTimestamp + MUTABLE_WAVE_PROPAGATION.STEP_INTERVAL_MS;
    return true;
  }

  return false;
}

export function updateWavePropagation(
  neurons: Neuron[],
  activeWaves: PropagationWave[],
  currentTimestamp: number
): void {
  for (let waveIndex = activeWaves.length - 1; waveIndex >= 0; waveIndex--) {
    const wave = activeWaves[waveIndex];
    if (!wave) continue;

    if (currentTimestamp >= wave.nextPropagationTimestamp) {
      const isStillActive = propagateWaveStep(wave, neurons, currentTimestamp);

      if (!isStillActive) {
        activeWaves.splice(waveIndex, 1);
      }
    }
  }
}

export function reducePropagationProbabilityByHalf(): void {
  const currentProbability = MUTABLE_WAVE_PROPAGATION.PROPAGATION_PROBABILITY;

  if (currentProbability === 1) {
    MUTABLE_WAVE_PROPAGATION.PROPAGATION_PROBABILITY = 0.5;
  } else {
    MUTABLE_WAVE_PROPAGATION.PROPAGATION_PROBABILITY = currentProbability / 2;
  }
}

export function resetPropagationProbability(): void {
  MUTABLE_WAVE_PROPAGATION.PROPAGATION_PROBABILITY = WAVE_PROPAGATION.PROPAGATION_PROBABILITY;
}

export function setPropagationProbability(probability: number): void {
  MUTABLE_WAVE_PROPAGATION.PROPAGATION_PROBABILITY = Math.max(0, Math.min(1, probability));
}

export function getCurrentPropagationProbability(): number {
  return MUTABLE_WAVE_PROPAGATION.PROPAGATION_PROBABILITY;
}
