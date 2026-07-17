/**
 * Brain State Hook.
 *
 * Encapsulates all UI state for the brain visualization.
 */

import { useState, useCallback, useMemo } from 'react';
import { NeuralActivityLevel, BrainVisibilityState } from '../types';
import type { BrainState, BrainStateActions } from '../types';
import { WAVE_PROPAGATION } from '../constants';
import { setPropagationProbability } from '../core/brain-physics';

export interface UseBrainStateOptions {
  defaultActivityLevel?: NeuralActivityLevel;
  defaultVisibilityState?: BrainVisibilityState;
  defaultGlowEnabled?: boolean;
}

export interface UseBrainStateResult {
  state: BrainState;
  actions: BrainStateActions;
}

export function useBrainState(options: UseBrainStateOptions = {}): UseBrainStateResult {
  const {
    defaultActivityLevel = NeuralActivityLevel.LOW,
    defaultVisibilityState = BrainVisibilityState.ASSEMBLED,
    defaultGlowEnabled = true,
  } = options;

  const [activityLevel, setActivityLevel] = useState<NeuralActivityLevel>(defaultActivityLevel);
  const [visibilityState, setVisibilityState] = useState<BrainVisibilityState>(
    defaultVisibilityState
  );
  const [glowEnabled, setGlowEnabled] = useState<boolean>(defaultGlowEnabled);
  const [propagationProbability, setPropagationProbabilityState] = useState<number>(
    WAVE_PROPAGATION.PROPAGATION_PROBABILITY
  );

  const toggleActivity = useCallback((): void => {
    setActivityLevel((current: NeuralActivityLevel) =>
      current === NeuralActivityLevel.LOW ? NeuralActivityLevel.HIGH : NeuralActivityLevel.LOW
    );
  }, []);

  const setActivityLevelValue = useCallback((level: NeuralActivityLevel): void => {
    setActivityLevel(level);
  }, []);

  const toggleVisibility = useCallback((): void => {
    setVisibilityState((current: BrainVisibilityState) =>
      current === BrainVisibilityState.ASSEMBLED
        ? BrainVisibilityState.DISPERSED
        : BrainVisibilityState.ASSEMBLED
    );
  }, []);

  const setVisibilityStateValue = useCallback((state: BrainVisibilityState): void => {
    setVisibilityState(state);
  }, []);

  const toggleGlow = useCallback((): void => {
    setGlowEnabled((current: boolean) => !current);
  }, []);

  const setPropagation = useCallback((probability: number): void => {
    setPropagationProbability(probability);
    setPropagationProbabilityState(probability);
  }, []);

  const state = useMemo(
    () => ({
      activityLevel,
      visibilityState,
      glowEnabled,
      propagationProbability,
    }),
    [activityLevel, visibilityState, glowEnabled, propagationProbability]
  );

  const actions = useMemo(
    () => ({
      toggleActivity,
      setActivityLevel: setActivityLevelValue,
      toggleVisibility,
      setVisibilityState: setVisibilityStateValue,
      toggleGlow,
      setPropagation,
    }),
    [
      toggleActivity,
      setActivityLevelValue,
      toggleVisibility,
      setVisibilityStateValue,
      toggleGlow,
      setPropagation,
    ]
  );

  return { state, actions };
}
