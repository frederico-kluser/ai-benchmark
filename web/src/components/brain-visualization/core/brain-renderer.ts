/**
 * Brain Renderer.
 *
 * Handles canvas rendering including 3D to 2D projection, neuron rendering,
 * connection lines, and glow effects.
 */

import type { Neuron, ProjectedNeuron, RotationAngles } from '../types';
import { rotateAroundXAxis, rotateAroundYAxis, projectToScreen } from '../math3d';
import {
  RENDERING,
  MUTABLE_WAVE_PROPAGATION,
  COLORS,
  OPACITY,
  LINE_WIDTHS,
} from '../constants';

function calculateImplosionGlow(globalPhase: number, suctionDelayFactor: number): boolean {
  if (globalPhase > 1) return false;

  const adjustedProgress = Math.max(
    0,
    (globalPhase - suctionDelayFactor) / (1 - suctionDelayFactor)
  );
  const easedProgress = adjustedProgress * adjustedProgress;

  return easedProgress > OPACITY.IMPLOSION_GLOW_THRESHOLD;
}

function calculateWaveActivationAlpha(
  lastActivationTimestamp: number,
  currentTimestamp: number
): number {
  const timeSinceActivation = currentTimestamp - lastActivationTimestamp;

  if (
    timeSinceActivation < 0 ||
    timeSinceActivation >= MUTABLE_WAVE_PROPAGATION.GLOW_DURATION_MS
  ) {
    return 0;
  }

  const linearAlpha = 1 - timeSinceActivation / MUTABLE_WAVE_PROPAGATION.GLOW_DURATION_MS;
  return Math.pow(linearAlpha, RENDERING.GLOW_EASING_POWER);
}

function projectSingleNeuron(
  neuron: Neuron,
  canvasWidth: number,
  canvasHeight: number,
  rotation: RotationAngles,
  globalPhase: number,
  currentTimestamp: number
): ProjectedNeuron {
  const implosionGlow = calculateImplosionGlow(globalPhase, neuron.suctionDelayFactor);
  const waveAlpha = calculateWaveActivationAlpha(
    neuron.lastActivationTimestamp,
    currentTimestamp
  );
  const isGlowing = implosionGlow || waveAlpha > 0.1;

  let rotatedPosition = rotateAroundYAxis(neuron.currentPosition, rotation.y);
  rotatedPosition = rotateAroundXAxis(rotatedPosition, rotation.x);

  const projection = projectToScreen(
    rotatedPosition,
    canvasWidth,
    canvasHeight,
    RENDERING.PERSPECTIVE_FOV,
    RENDERING.CAMERA_Z_POSITION
  );

  return {
    screenX: projection.x,
    screenY: projection.y,
    perspectiveScale: projection.scale,
    depth: rotatedPosition.z,
    isGlowing,
    waveActivationAlpha: waveAlpha,
  };
}

export function projectAllNeurons(
  neurons: Neuron[],
  canvasWidth: number,
  canvasHeight: number,
  rotation: RotationAngles,
  globalPhase: number,
  currentTimestamp: number
): Map<number, ProjectedNeuron> {
  const projectedNeurons = new Map<number, ProjectedNeuron>();

  for (const neuron of neurons) {
    const projected = projectSingleNeuron(
      neuron,
      canvasWidth,
      canvasHeight,
      rotation,
      globalPhase,
      currentTimestamp
    );
    projectedNeurons.set(neuron.id, projected);
  }

  return projectedNeurons;
}

function formatRgba(color: { r: number; g: number; b: number }, alpha: number): string {
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`;
}

function drawWireframeCube(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  size: number
): void {
  const halfSize = size / 2;
  const perspectiveOffset = halfSize * LINE_WIDTHS.CUBE_PERSPECTIVE_OFFSET;

  ctx.lineWidth = LINE_WIDTHS.CUBE_WIREFRAME;

  ctx.strokeRect(centerX - halfSize, centerY - halfSize, size, size);

  ctx.beginPath();

  ctx.rect(
    centerX - halfSize + perspectiveOffset,
    centerY - halfSize - perspectiveOffset,
    size,
    size
  );

  ctx.moveTo(centerX - halfSize, centerY - halfSize);
  ctx.lineTo(centerX - halfSize + perspectiveOffset, centerY - halfSize - perspectiveOffset);

  ctx.moveTo(centerX + halfSize, centerY - halfSize);
  ctx.lineTo(centerX + halfSize + perspectiveOffset, centerY - halfSize - perspectiveOffset);

  ctx.moveTo(centerX + halfSize, centerY + halfSize);
  ctx.lineTo(centerX + halfSize + perspectiveOffset, centerY + halfSize - perspectiveOffset);

  ctx.moveTo(centerX - halfSize, centerY + halfSize);
  ctx.lineTo(centerX - halfSize + perspectiveOffset, centerY + halfSize - perspectiveOffset);

  ctx.stroke();
}

function drawGlowingNeuron(
  ctx: CanvasRenderingContext2D,
  screenX: number,
  screenY: number,
  size: number,
  intensity: number
): void {
  const halfSize = size / 2;

  ctx.fillStyle = formatRgba(COLORS.NEURON_ACTIVE, intensity);
  ctx.fillRect(screenX - halfSize, screenY - halfSize, size, size);

  if (intensity > RENDERING.GLOW_HALO_THRESHOLD) {
    const haloSize = size * RENDERING.HALO_SIZE_MULTIPLIER;
    ctx.fillStyle = formatRgba(COLORS.GLOW_HALO, intensity * OPACITY.GLOW_HALO);
    ctx.beginPath();
    ctx.arc(screenX, screenY, haloSize, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawIdleNeuron(
  ctx: CanvasRenderingContext2D,
  screenX: number,
  screenY: number,
  size: number
): void {
  ctx.strokeStyle = formatRgba(COLORS.NEURON_IDLE, OPACITY.NEURON_IDLE_STROKE);

  if (size < 0.5) {
    ctx.fillStyle = formatRgba(COLORS.NEURON_IDLE, OPACITY.NEURON_IDLE_FILL);
    ctx.fillRect(screenX, screenY, 1, 1);
  } else {
    drawWireframeCube(ctx, screenX, screenY, size);
  }
}

function drawNeuronConnections(
  ctx: CanvasRenderingContext2D,
  neurons: Neuron[],
  projectedNeurons: Map<number, ProjectedNeuron>,
  globalConnectionAlpha: number
): void {
  for (const neuron of neurons) {
    const sourceProjection = projectedNeurons.get(neuron.id);
    if (!sourceProjection || sourceProjection.perspectiveScale <= 0) continue;

    if (globalConnectionAlpha < 0.1 && sourceProjection.waveActivationAlpha < 0.1) continue;

    for (const targetId of neuron.connectionIds) {
      if (targetId <= neuron.id) continue;

      const targetProjection = projectedNeurons.get(targetId);
      if (!targetProjection || targetProjection.perspectiveScale <= 0) continue;

      ctx.beginPath();
      ctx.moveTo(sourceProjection.screenX, sourceProjection.screenY);
      ctx.lineTo(targetProjection.screenX, targetProjection.screenY);

      const maxWaveAlpha = Math.max(
        sourceProjection.waveActivationAlpha,
        targetProjection.waveActivationAlpha
      );

      if (maxWaveAlpha > 0.1) {
        ctx.lineWidth = LINE_WIDTHS.CONNECTION_ACTIVE * globalConnectionAlpha;
        ctx.strokeStyle = formatRgba(
          COLORS.CONNECTION_ACTIVE,
          OPACITY.CONNECTION_ACTIVE * maxWaveAlpha * globalConnectionAlpha
        );
      } else {
        ctx.lineWidth = LINE_WIDTHS.CONNECTION_IDLE;
        ctx.strokeStyle = formatRgba(
          COLORS.CONNECTION_IDLE,
          OPACITY.CONNECTION_IDLE * globalConnectionAlpha
        );
      }

      ctx.stroke();
    }
  }
}

function calculateConnectionAlpha(globalPhase: number): number {
  if (globalPhase >= RENDERING.CONNECTION_VISIBLE_PHASE) {
    return 0;
  }

  const fadeProgress = globalPhase / RENDERING.CONNECTION_VISIBLE_PHASE;
  return Math.max(0, Math.min(1, 1 - fadeProgress));
}

export function renderBrainVisualization(
  ctx: CanvasRenderingContext2D,
  neurons: Neuron[],
  projectedNeurons: Map<number, ProjectedNeuron>,
  globalPhase: number
): void {
  const connectionAlpha = calculateConnectionAlpha(globalPhase);

  if (connectionAlpha > 0.01) {
    drawNeuronConnections(ctx, neurons, projectedNeurons, connectionAlpha);
  }

  for (const neuron of neurons) {
    const projection = projectedNeurons.get(neuron.id);

    if (!projection) continue;
    if (projection.perspectiveScale <= 0) continue;
    if (projection.perspectiveScale < RENDERING.MIN_RENDER_SCALE) continue;

    const neuronSize = RENDERING.NEURON_BASE_SIZE * projection.perspectiveScale;

    if (projection.isGlowing) {
      const glowIntensity = projection.waveActivationAlpha > 0 ? projection.waveActivationAlpha : 1;
      drawGlowingNeuron(ctx, projection.screenX, projection.screenY, neuronSize, glowIntensity);
    } else {
      drawIdleNeuron(ctx, projection.screenX, projection.screenY, neuronSize);
    }
  }
}
