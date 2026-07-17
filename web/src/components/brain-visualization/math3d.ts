/**
 * 3D Mathematics Utilities.
 *
 * Pure functions for 3D transformations including rotation, projection, and
 * random number generation. All functions are stateless and return new objects.
 */

import type { Point3D } from './types';

export interface ProjectionResult {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

export function rotateAroundYAxis(point: Point3D, angleRadians: number): Point3D {
  const cosAngle = Math.cos(angleRadians);
  const sinAngle = Math.sin(angleRadians);

  return {
    x: point.x * cosAngle - point.z * sinAngle,
    y: point.y,
    z: point.x * sinAngle + point.z * cosAngle,
  };
}

export function rotateAroundXAxis(point: Point3D, angleRadians: number): Point3D {
  const cosAngle = Math.cos(angleRadians);
  const sinAngle = Math.sin(angleRadians);

  return {
    x: point.x,
    y: point.y * cosAngle - point.z * sinAngle,
    z: point.y * sinAngle + point.z * cosAngle,
  };
}

export function projectToScreen(
  point: Point3D,
  canvasWidth: number,
  canvasHeight: number,
  fieldOfView: number,
  cameraZPosition: number
): ProjectionResult {
  const perspectiveScale = fieldOfView / (fieldOfView + point.z - cameraZPosition);
  const screenX = point.x * perspectiveScale + canvasWidth / 2;
  const screenY = point.y * perspectiveScale + canvasHeight / 2;

  return {
    x: screenX,
    y: screenY,
    scale: perspectiveScale,
  };
}

export function generateRandomInRange(minValue: number, maxValue: number): number {
  return Math.random() * (maxValue - minValue) + minValue;
}

export function calculateDistance3D(pointA: Point3D, pointB: Point3D): number {
  const deltaX = pointA.x - pointB.x;
  const deltaY = pointA.y - pointB.y;
  const deltaZ = pointA.z - pointB.z;

  return Math.sqrt(deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ);
}

export function calculateMagnitude(vector: Point3D): number {
  return Math.sqrt(vector.x * vector.x + vector.y * vector.y + vector.z * vector.z);
}

export function normalizeVector(vector: Point3D): Point3D {
  const magnitude = calculateMagnitude(vector);

  if (magnitude === 0) {
    return { x: 0, y: 0, z: 0 };
  }

  return {
    x: vector.x / magnitude,
    y: vector.y / magnitude,
    z: vector.z / magnitude,
  };
}

export function createZeroPoint(): Point3D {
  return { x: 0, y: 0, z: 0 };
}

export function clonePoint(point: Point3D): Point3D {
  return { x: point.x, y: point.y, z: point.z };
}
