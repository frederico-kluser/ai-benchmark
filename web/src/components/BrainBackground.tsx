import { useEffect, useState } from 'react';
import { BrainCanvas, useBrainState, NeuralActivityLevel, BrainVisibilityState } from './brain-visualization';

interface BrainBackgroundProps {
  isThinking?: boolean;
}

export function BrainBackground({ isThinking = false }: BrainBackgroundProps) {
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
      />
    </div>
  );
}
