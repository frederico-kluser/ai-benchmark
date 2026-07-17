import { useEffect, useState, useMemo } from 'react';
import { useTheme } from '../theme';
import { BrainCanvas, useBrainState, NeuralActivityLevel, BrainVisibilityState } from './brain-visualization';
import type { BrainColors } from './brain-visualization/constants';

interface BrainBackgroundProps {
  isThinking?: boolean;
}

const LIGHT_COLORS: Partial<BrainColors> = {
  // Efeito de propagação/ativação em amarelo forte no tema claro.
  NEURON_ACTIVE: { r: 255, g: 220, b: 0 },
  GLOW_HALO: { r: 255, g: 200, b: 0 },
  CONNECTION_ACTIVE: { r: 255, g: 220, b: 0 },
};

export function BrainBackground({ isThinking = false }: BrainBackgroundProps) {
  const theme = useTheme();
  const colors = useMemo(
    () => (theme === 'light' ? LIGHT_COLORS : undefined),
    [theme]
  );

  const { state, actions } = useBrainState({
    defaultActivityLevel: NeuralActivityLevel.LOW,
    defaultVisibilityState: BrainVisibilityState.DISPERSED,
    defaultGlowEnabled: false,
  });

  const [mounted, setMounted] = useState(false);

  // Ao montar, inicia a formação do cérebro vindo do estado disperso (explosão invertida).
  useEffect(() => {
    const timer = setTimeout(() => {
      setMounted(true);
      actions.setVisibilityState(BrainVisibilityState.ASSEMBLED);
    }, 100);
    return () => clearTimeout(timer);
  }, [actions]);

  // Aumenta a atividade neural quando o sistema está processando.
  useEffect(() => {
    if (!mounted) return;

    const nextLevel = isThinking ? NeuralActivityLevel.HIGH : NeuralActivityLevel.LOW;
    const nextPropagation = isThinking ? 0.85 : 0.35;

    if (state.activityLevel !== nextLevel) {
      actions.setActivityLevel(nextLevel);
    }
    actions.setPropagation(nextPropagation);
  }, [isThinking, state.activityLevel, actions, mounted]);

  return (
    <div className={`brain-background ${isThinking ? 'thinking' : ''}`} aria-hidden="true">
      <BrainCanvas
        activityLevel={state.activityLevel}
        visibilityState={state.visibilityState}
        rotationConfig={{ enabled: true, ySpeed: 0.5, xAmplitude: 0.12, xFrequency: 0.6 }}
        colors={colors}
      />
    </div>
  );
}
