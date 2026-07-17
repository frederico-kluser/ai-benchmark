/**
 * Drag Rotation Hook.
 *
 * Enables manual brain rotation via mouse drag and touch gestures.
 */

import { useEffect, useRef, useCallback, type RefObject } from 'react';
import type { DragRotationOffset } from '../types';
import { DRAG_ROTATION } from '../constants';

interface DragRotationResult {
  dragOffsetRef: RefObject<DragRotationOffset>;
  isDraggingRef: RefObject<boolean>;
}

interface DragState {
  isDragging: boolean;
  lastPointerX: number;
  lastPointerY: number;
  velocityX: number;
  velocityY: number;
}

function tickInertia(
  dragState: DragState,
  dragOffset: DragRotationOffset,
  inertiaFrameRef: { current: number },
  scheduleSelf: () => void
): void {
  if (dragState.isDragging) return;

  if (
    Math.abs(dragState.velocityX) < DRAG_ROTATION.VELOCITY_THRESHOLD &&
    Math.abs(dragState.velocityY) < DRAG_ROTATION.VELOCITY_THRESHOLD
  ) {
    return;
  }

  dragOffset.y += dragState.velocityX;
  dragOffset.x += dragState.velocityY;

  dragState.velocityX *= DRAG_ROTATION.INERTIA_DECAY;
  dragState.velocityY *= DRAG_ROTATION.INERTIA_DECAY;

  inertiaFrameRef.current = requestAnimationFrame(scheduleSelf);
}

export function useDragRotation(
  canvasRef: RefObject<HTMLCanvasElement | null>
): DragRotationResult {
  const dragOffsetRef = useRef<DragRotationOffset>({ x: 0, y: 0 });
  const isDraggingRef = useRef<boolean>(false);
  const dragStateRef = useRef<DragState>({
    isDragging: false,
    lastPointerX: 0,
    lastPointerY: 0,
    velocityX: 0,
    velocityY: 0,
  });
  const inertiaFrameRef = useRef<number>(0);

  const applyInertia = useCallback((): void => {
    tickInertia(dragStateRef.current, dragOffsetRef.current, inertiaFrameRef, applyInertia);
  }, []);

  const handlePointerDown = useCallback((event: PointerEvent): void => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.setPointerCapture(event.pointerId);

    const state = dragStateRef.current;
    state.isDragging = true;
    state.lastPointerX = event.clientX;
    state.lastPointerY = event.clientY;
    state.velocityX = 0;
    state.velocityY = 0;
    isDraggingRef.current = true;

    if (inertiaFrameRef.current) {
      cancelAnimationFrame(inertiaFrameRef.current);
      inertiaFrameRef.current = 0;
    }
  }, [canvasRef]);

  const handlePointerMove = useCallback((event: PointerEvent): void => {
    const state = dragStateRef.current;
    if (!state.isDragging) return;

    const deltaX = event.clientX - state.lastPointerX;
    const deltaY = event.clientY - state.lastPointerY;

    dragOffsetRef.current.y += deltaX * DRAG_ROTATION.SENSITIVITY;
    dragOffsetRef.current.x += deltaY * DRAG_ROTATION.SENSITIVITY;
    state.velocityX = deltaX * DRAG_ROTATION.SENSITIVITY;
    state.velocityY = deltaY * DRAG_ROTATION.SENSITIVITY;
    state.lastPointerX = event.clientX;
    state.lastPointerY = event.clientY;
  }, []);

  const handlePointerUp = useCallback((): void => {
    dragStateRef.current.isDragging = false;
    isDraggingRef.current = false;
    inertiaFrameRef.current = requestAnimationFrame(applyInertia);
  }, [applyInertia]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.addEventListener('pointerdown', handlePointerDown);
    canvas.addEventListener('pointermove', handlePointerMove);
    canvas.addEventListener('pointerup', handlePointerUp);
    canvas.addEventListener('pointercancel', handlePointerUp);

    return (): void => {
      canvas.removeEventListener('pointerdown', handlePointerDown);
      canvas.removeEventListener('pointermove', handlePointerMove);
      canvas.removeEventListener('pointerup', handlePointerUp);
      canvas.removeEventListener('pointercancel', handlePointerUp);

      if (inertiaFrameRef.current) {
        cancelAnimationFrame(inertiaFrameRef.current);
      }
    };
  }, [canvasRef, handlePointerDown, handlePointerMove, handlePointerUp]);

  return { dragOffsetRef, isDraggingRef };
}
