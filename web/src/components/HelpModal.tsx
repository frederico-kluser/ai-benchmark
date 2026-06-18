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
    body: 'Compare vários LLMs no mesmo desafio, lado a lado. Você define um tema; um modelo gerador inventa cenários realistas; os competidores respondem em paralelo; e um juiz ranqueia as respostas às cegas. No fim, você vê quem foi melhor — e por quê.',
  },
  {
    kicker: 'Passo 1',
    title: 'Monte uma run',
    body: 'Em “Nova Run”, escreva o tema (ou use um dos exemplos), escolha 2 ou mais competidores, 1 gerador e 1 juiz. O painel “Resumo da run” mostra o custo estimado e o nº de chamadas antes de você iniciar. Concorrência e timeout ficam em “Ajustes avançados”.',
  },
  {
    kicker: 'Passo 2',
    title: 'Acompanhe ao vivo',
    body: 'Ao iniciar, você vai para a Visão da Run. As etapas abrem sozinhas e você vê cada modelo respondendo token a token, com contadores de caracteres e o anel de progresso das etapas no topo.',
  },
  {
    kicker: 'Passo 3',
    title: 'Leia o resultado',
    body: 'Quando o juiz termina, a aba “Resumo” traz a classificação (pontos, 1ºs, posição média e % de respostas aceitáveis) e o heatmap de posições — verde é melhor, vermelho é pior. A aba “Etapas” mostra cada resposta com o veredito e a justificativa.',
  },
  {
    kicker: 'Passo 4',
    title: 'Chave, histórico e tema',
    body: 'Em “Configurações”, cole sua chave da OpenRouter — ela fica salva só no seu navegador. Em “Histórico”, você revisita runs anteriores, filtra por status e busca por tema. E o botão sol/lua alterna entre os modos claro e escuro a qualquer momento.',
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
