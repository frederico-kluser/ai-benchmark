/**
 * BrainVisualization Organism.
 *
 * Top-level composition that wires state into the presentational molecules.
 */

import type { ReactElement } from 'react';
import type { NeuralActivityLevel, BrainVisibilityState, RotationConfig } from '../../types';
import { useBrainState } from '../../hooks/use-brain-state';
import { GlowBackdrop } from '../atoms/GlowBackdrop';
import { BrainCanvas } from '../molecules/BrainCanvas';

export interface BrainVisualizationProps {
  className?: string;
  defaultActivityLevel?: NeuralActivityLevel;
  defaultVisibilityState?: BrainVisibilityState;
  defaultGlowEnabled?: boolean;
  showGlowBackdrop?: boolean;
  rotationConfig?: RotationConfig;
}

export function BrainVisualization({
  className = '',
  defaultActivityLevel,
  defaultVisibilityState,
  defaultGlowEnabled,
  showGlowBackdrop = true,
  rotationConfig,
}: BrainVisualizationProps): ReactElement {
  const { state } = useBrainState({
    ...(defaultActivityLevel !== undefined && { defaultActivityLevel }),
    ...(defaultVisibilityState !== undefined && { defaultVisibilityState }),
    ...(defaultGlowEnabled !== undefined && { defaultGlowEnabled }),
  });

  return (
    <div className={`brain-viz ${className}`}>
      {showGlowBackdrop && <GlowBackdrop visible={state.glowEnabled} />}

      <BrainCanvas
        activityLevel={state.activityLevel}
        visibilityState={state.visibilityState}
        {...(rotationConfig !== undefined && { rotationConfig })}
      />
    </div>
  );
}
