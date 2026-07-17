/**
 * BrainCanvas Molecule.
 *
 * Composes BrainCanvasElement with animation and drag hooks.
 */

import { useRef, type ReactElement } from 'react';
import type { NeuralActivityLevel, BrainVisibilityState, RotationConfig } from '../../types';
import type { BrainColors } from '../../constants';
import { useBrainAnimation } from '../../hooks/use-brain-animation';
import { useDragRotation } from '../../hooks/use-drag-rotation';
import { BrainCanvasElement } from '../atoms/BrainCanvasElement';

export interface BrainCanvasProps {
  activityLevel: NeuralActivityLevel;
  visibilityState: BrainVisibilityState;
  rotationConfig?: RotationConfig;
  colors?: Partial<BrainColors>;
}

export function BrainCanvas({
  activityLevel,
  visibilityState,
  rotationConfig,
  colors,
}: BrainCanvasProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { dragOffsetRef, isDraggingRef } = useDragRotation(canvasRef);

  useBrainAnimation(
    activityLevel,
    visibilityState,
    canvasRef,
    dragOffsetRef,
    isDraggingRef,
    rotationConfig,
    colors
  );

  return (
    <div className="brain-canvas-wrap">
      <BrainCanvasElement ref={canvasRef} />
    </div>
  );
}
