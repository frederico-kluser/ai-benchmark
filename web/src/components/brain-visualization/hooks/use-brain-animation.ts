/**
 * Brain Animation Hook.
 *
 * Orchestrates the brain visualization: initializes the neural network,
 * manages animation loop, handles state transitions, and coordinates physics
 * updates and rendering.
 */

import { useEffect, useRef, useCallback, type RefObject } from 'react';
import type {
  Neuron,
  PropagationWave,
  AnimationPhaseState,
  DragRotationOffset,
  WaveIdCounter,
  RotationConfig,
} from '../types';
import { NeuralActivityLevel, BrainVisibilityState } from '../types';
import type { BrainColors } from '../constants';
import { createBrainNeuralNetwork } from '../core/brain-factory';
import {
  calculateRotationAngles,
  calculateAnimationPhase,
  updateNeuronPositions,
  spawnDualHemisphereWaves,
  updateWavePropagation,
} from '../core/brain-physics';
import { projectAllNeurons, renderBrainVisualization } from '../core/brain-renderer';
import { ANIMATION_TIMING, MUTABLE_WAVE_PROPAGATION, RENDERING } from '../constants';

function getAnimationDuration(isHiding: boolean): number {
  return isHiding ? ANIMATION_TIMING.HIDE_DURATION_MS : ANIMATION_TIMING.SHOW_DURATION_MS;
}

function getWaveSpawnInterval(activityLevel: NeuralActivityLevel): number {
  return activityLevel === NeuralActivityLevel.HIGH
    ? MUTABLE_WAVE_PROPAGATION.SPAWN_INTERVAL_HIGH_MS
    : MUTABLE_WAVE_PROPAGATION.SPAWN_INTERVAL_LOW_MS;
}

function canSpawnWaves(visibilityState: BrainVisibilityState, currentPhase: number): boolean {
  return (
    visibilityState === BrainVisibilityState.ASSEMBLED &&
    currentPhase < RENDERING.WAVE_SPAWN_PHASE_THRESHOLD
  );
}

function shouldSkipRender(currentPhase: number, visibilityState: BrainVisibilityState): boolean {
  return (
    currentPhase >= RENDERING.STOP_ANIMATION_PHASE &&
    visibilityState === BrainVisibilityState.DISPERSED
  );
}

export function useBrainAnimation(
  activityLevel: NeuralActivityLevel,
  visibilityState: BrainVisibilityState,
  externalCanvasRef?: RefObject<HTMLCanvasElement | null>,
  dragOffsetRef?: RefObject<DragRotationOffset>,
  isDraggingRef?: RefObject<boolean>,
  rotationConfig?: RotationConfig,
  colors?: Partial<BrainColors>
): RefObject<HTMLCanvasElement | null> {
  const internalCanvasRef = useRef<HTMLCanvasElement>(null);
  const canvasRef = externalCanvasRef ?? internalCanvasRef;

  const neuronsRef = useRef<Neuron[]>([]);
  const activeWavesRef = useRef<PropagationWave[]>([]);
  const waveIdCounterRef = useRef<WaveIdCounter>({ current: 0 });
  const lastWaveSpawnTimeRef = useRef<number>(0);
  const animationFrameIdRef = useRef<number>(0);

  const animationStateRef = useRef<AnimationPhaseState>({
    startTimestamp: 0,
    startPhase: visibilityState === BrainVisibilityState.ASSEMBLED ? 0 : 2,
    targetPhase: visibilityState === BrainVisibilityState.ASSEMBLED ? 0 : 2,
    isAnimating: false,
  });

  const previousVisibilityRef = useRef<BrainVisibilityState>(visibilityState);
  const animationDurationRef = useRef<number>(ANIMATION_TIMING.SHOW_DURATION_MS);

  useEffect(() => {
    neuronsRef.current = createBrainNeuralNetwork();
  }, []);

  useEffect(() => {
    if (previousVisibilityRef.current !== visibilityState) {
      const isHiding = visibilityState === BrainVisibilityState.DISPERSED;
      animationDurationRef.current = getAnimationDuration(isHiding);

      animationStateRef.current = {
        startTimestamp: Date.now(),
        startPhase: isHiding ? 0 : 2,
        targetPhase: isHiding ? 2 : 0,
        isAnimating: true,
      };

      previousVisibilityRef.current = visibilityState;
    }
  }, [visibilityState]);

  const runAnimationFrame = useCallback((): void => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const canvasWidth = canvas.width;
    const canvasHeight = canvas.height;
    const currentTimestamp = Date.now();

    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    const normalizedTime = currentTimestamp * ANIMATION_TIMING.GLOBAL_TIME_SCALE;
    const rotation = calculateRotationAngles(
      normalizedTime,
      dragOffsetRef?.current ?? undefined,
      isDraggingRef?.current ?? undefined,
      rotationConfig
    );

    let currentPhase = animationStateRef.current.startPhase;

    if (animationStateRef.current.isAnimating) {
      const phaseResult = calculateAnimationPhase(
        animationStateRef.current.startTimestamp,
        animationDurationRef.current,
        animationStateRef.current.startPhase,
        animationStateRef.current.targetPhase,
        currentTimestamp
      );

      currentPhase = phaseResult.phase;

      if (phaseResult.isComplete) {
        animationStateRef.current.isAnimating = false;
        animationStateRef.current.startPhase = animationStateRef.current.targetPhase;
      }
    }

    if (shouldSkipRender(currentPhase, visibilityState)) {
      animationFrameIdRef.current = requestAnimationFrame(runAnimationFrame);
      return;
    }

    updateNeuronPositions(neuronsRef.current, currentPhase);

    if (canSpawnWaves(visibilityState, currentPhase)) {
      const spawnInterval = getWaveSpawnInterval(activityLevel);

      if (currentTimestamp - lastWaveSpawnTimeRef.current > spawnInterval) {
        spawnDualHemisphereWaves(
          neuronsRef.current,
          activeWavesRef.current,
          waveIdCounterRef.current,
          currentTimestamp
        );
        lastWaveSpawnTimeRef.current = currentTimestamp;
      }

      updateWavePropagation(neuronsRef.current, activeWavesRef.current, currentTimestamp);
    } else {
      activeWavesRef.current = [];
    }

    let globalAlpha = 1;
    if (currentPhase > 1) {
      globalAlpha = Math.max(0, 1 - (currentPhase - 1));
    }
    ctx.globalAlpha = globalAlpha;

    const projectedNeurons = projectAllNeurons(
      neuronsRef.current,
      canvasWidth,
      canvasHeight,
      rotation,
      currentPhase,
      currentTimestamp
    );

    renderBrainVisualization(ctx, neuronsRef.current, projectedNeurons, currentPhase, colors);

    ctx.globalAlpha = 1;
    animationFrameIdRef.current = requestAnimationFrame(runAnimationFrame);
  }, [activityLevel, visibilityState, canvasRef, dragOffsetRef, isDraggingRef, rotationConfig, colors]);

  useEffect(() => {
    function handleResize(): void {
      const canvas = canvasRef.current;
      const parentElement = canvas?.parentElement;

      if (canvas && parentElement) {
        canvas.width = parentElement.offsetWidth;
        canvas.height = parentElement.offsetHeight;
      }
    }

    window.addEventListener('resize', handleResize);
    handleResize();

    return (): void => {
      window.removeEventListener('resize', handleResize);
    };
  }, [canvasRef]);

  useEffect(() => {
    animationFrameIdRef.current = requestAnimationFrame(runAnimationFrame);

    return (): void => {
      if (animationFrameIdRef.current) {
        cancelAnimationFrame(animationFrameIdRef.current);
      }
    };
  }, [runAnimationFrame]);

  return canvasRef;
}
