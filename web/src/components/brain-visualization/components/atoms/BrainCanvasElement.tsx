/**
 * BrainCanvasElement Atom.
 *
 * Pure canvas element with forwarded ref.
 */

import { forwardRef, type ReactElement } from 'react';

export interface BrainCanvasElementProps {
  className?: string;
}

export const BrainCanvasElement = forwardRef<HTMLCanvasElement, BrainCanvasElementProps>(
  function BrainCanvasElement({ className = '' }, ref): ReactElement {
    return (
      <canvas
        ref={ref}
        className={`brain-canvas ${className}`}
      />
    );
  }
);
