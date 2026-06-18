import { useEffect, useState } from 'react';

interface Step {
  kicker: string;
  title: string;
  body: string;
}

const STEPS: Step[] = [
  {
    kicker: 'Visão geral',
    title: 'Bem-vindo ao Benchmark Arena',
    body: 'Descubra qual LLM — ou qual prompt — responde melhor a um desafio. Você define um tema; um modelo gerador inventa cenários realistas; os concorrentes respondem em paralelo; e um juiz ranqueia as respostas às cegas. No fim, você vê quem foi melhor — e por quê.',
  },
  {
    kicker: 'Passo 1',
    title: 'Escolha o modo',
    body: 'Em “Nova Run”, escolha entre três modos: Comparar (vários modelos no mesmo desafio), Variação (um modelo com várias variações de system prompt) e Treino (iterativo — a cada rodada a melhor variação evolui, em busca do melhor prompt).',
  },
  {
    kicker: 'Passo 2',
    title: 'Monte a run',
    body: 'Escreva o tema (ou use um exemplo). Em Comparar, escolha 2+ competidores. Em Variação/Treino, escolha o modelo sob teste e as técnicas de prompt (cada uma vira uma variação) — ou desligue a otimização e escreva as variações à mão; o prompt base é opcional. O painel “Resumo da run” mostra variantes, chamadas e custo estimado.',
  },
  {
    kicker: 'Passo 3',
    title: 'Acompanhe ao vivo',
    body: 'Ao iniciar, você vai para a Visão da Run. As etapas abrem sozinhas e você vê cada resposta sendo gerada token a token, com contadores e o anel de progresso no topo. Em Variação/Treino, o painel “Variantes de prompt” mostra o system prompt de cada concorrente.',
  },
  {
    kicker: 'Passo 4',
    title: 'Leia o resultado',
    body: 'Quando o juiz termina, a aba “Resumo” traz a classificação (pontos, 1ºs, posição média e % de respostas aceitáveis) e o heatmap — verde é melhor, vermelho é pior. No Treino, a tela da sessão mostra a curva de melhoria por iteração e o melhor prompt final, pronto para copiar.',
  },
  {
    kicker: 'Passo 5',
    title: 'Chave, histórico e tema',
    body: 'Em “Configurações”, cole sua chave da OpenRouter — ela fica salva só no seu navegador. Em “Histórico”, você revisita runs e treinos, filtra por status e busca por tema. E o botão sol/lua alterna entre claro e escuro a qualquer momento.',
  },
];

export function HelpModal({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const s = STEPS[step];
  const isLast = step >= STEPS.length - 1;

  function next() {
    if (isLast) onClose();
    else setStep((i) => i + 1);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" aria-label="Fechar" onClick={onClose}>
          ×
        </button>
        <span className="modal-num">{step + 1}</span>
        <div className="modal-kicker">{s.kicker}</div>
        <h2 className="modal-title">{s.title}</h2>
        <p className="modal-body">{s.body}</p>
        <div className="modal-foot">
          <div className="modal-dots">
            {STEPS.map((_, j) => (
              <button
                key={j}
                className={`modal-dot ${j === step ? 'active' : ''}`}
                aria-label={`Passo ${j + 1}`}
                onClick={() => setStep(j)}
              />
            ))}
          </div>
          <div className="modal-nav">
            {step > 0 && (
              <button className="modal-prev" onClick={() => setStep((i) => i - 1)}>
                Anterior
              </button>
            )}
            <button className="modal-next" onClick={next}>
              {isLast ? 'Começar' : 'Próximo'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
