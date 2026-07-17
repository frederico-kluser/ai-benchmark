/**
 * GlowBackdrop Atom.
 *
 * Decorative blue glow layer rendered behind the canvas.
 */

import type { ReactElement } from 'react';

export interface GlowBackdropProps {
  visible: boolean;
}

export function GlowBackdrop({ visible }: GlowBackdropProps): ReactElement {
  return (
    <div
      className={`brain-glow ${visible ? '' : 'brain-glow-hidden'}`}
      aria-hidden="true"
    >
      <div className="brain-glow-orb" />
    </div>
  );
}
