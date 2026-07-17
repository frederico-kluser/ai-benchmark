/**
 * Brain Network Factory.
 *
 * Creates and initializes the neural network structure including neuron
 * positions, connections, and animation properties.
 */

import type { Neuron, Point3D } from '../types';
import { NETWORK_TOPOLOGY, BRAIN_SHAPE, EXPLOSION } from '../constants';
import {
  normalizeVector,
  calculateDistance3D,
  createZeroPoint,
  clonePoint,
} from '../math3d';

function generateBrainPoint(radius: number): Point3D {
  const fissureGap = radius * BRAIN_SHAPE.FISSURE_GAP_RATIO;
  const temporalThreshold = radius * BRAIN_SHAPE.TEMPORAL_INDENT_THRESHOLD_RATIO;
  const temporalIndent = radius * BRAIN_SHAPE.TEMPORAL_INDENT_AMOUNT_RATIO;

  while (true) {
    const uniformU = Math.random();
    const uniformV = Math.random();
    const azimuthalAngle = 2 * Math.PI * uniformU;
    const polarAngle = Math.acos(2 * uniformV - 1);
    const randomRadius = Math.cbrt(Math.random()) * radius;

    const sphereX = randomRadius * Math.sin(polarAngle) * Math.cos(azimuthalAngle);
    const sphereY = randomRadius * Math.sin(polarAngle) * Math.sin(azimuthalAngle);
    const sphereZ = randomRadius * Math.cos(polarAngle);

    let brainX = sphereX * BRAIN_SHAPE.SCALE_X;
    let brainY = sphereY * BRAIN_SHAPE.SCALE_Y;
    const brainZ = sphereZ * BRAIN_SHAPE.SCALE_Z;

    if (Math.abs(brainX) < fissureGap) {
      continue;
    }

    if (brainY > temporalThreshold && brainZ > 0) {
      brainY -= temporalIndent;
    }

    return { x: brainX, y: brainY, z: brainZ };
  }
}

function generateAllBrainPoints(neuronCount: number, radius: number): Point3D[] {
  const points: Point3D[] = [];
  for (let i = 0; i < neuronCount; i++) {
    points.push(generateBrainPoint(radius));
  }
  return points;
}

function calculateExplosionDirection(position: Point3D): Point3D {
  return normalizeVector(position);
}

function generateSuctionDelay(): number {
  const randomValue = Math.random();
  const biasedValue = 1 - Math.pow(randomValue, EXPLOSION.SUCTION_DELAY_POWER);
  return biasedValue * EXPLOSION.MAX_SUCTION_DELAY;
}

function createNeuronFromPosition(position: Point3D, neuronId: number): Neuron {
  return {
    id: neuronId,
    basePosition: position,
    currentPosition: clonePoint(position),
    explosionDirection: calculateExplosionDirection(position),
    suctionDelayFactor: generateSuctionDelay(),
    velocity: createZeroPoint(),
    connectionIds: [],
    lastActivationTimestamp: 0,
  };
}

function shouldConnectNeurons(sourceNeuron: Neuron, targetNeuron: Neuron): boolean {
  if (sourceNeuron.id === targetNeuron.id) {
    return false;
  }

  const sourceIsLeft = sourceNeuron.basePosition.x < 0;
  const targetIsLeft = targetNeuron.basePosition.x < 0;
  if (sourceIsLeft !== targetIsLeft) {
    return false;
  }

  if (sourceNeuron.connectionIds.length >= NETWORK_TOPOLOGY.MAX_CONNECTIONS_PER_NEURON) {
    return false;
  }

  const distance = calculateDistance3D(sourceNeuron.basePosition, targetNeuron.basePosition);
  return distance < NETWORK_TOPOLOGY.MAX_CONNECTION_DISTANCE;
}

function buildNeuronConnections(neurons: Neuron[]): void {
  const neuronCount = neurons.length;

  for (let sourceIndex = 0; sourceIndex < neuronCount; sourceIndex++) {
    const sourceNeuron = neurons[sourceIndex];
    if (!sourceNeuron) continue;

    for (let targetIndex = 0; targetIndex < neuronCount; targetIndex++) {
      const targetNeuron = neurons[targetIndex];
      if (!targetNeuron) continue;

      if (shouldConnectNeurons(sourceNeuron, targetNeuron)) {
        (sourceNeuron.connectionIds as number[]).push(targetIndex);
      }
    }
  }
}

export function createBrainNeuralNetwork(): Neuron[] {
  const positions = generateAllBrainPoints(
    NETWORK_TOPOLOGY.NEURON_COUNT,
    NETWORK_TOPOLOGY.BRAIN_RADIUS
  );

  const neurons = positions.map((position, index) => createNeuronFromPosition(position, index));
  buildNeuronConnections(neurons);

  return neurons;
}
