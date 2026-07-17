import { useEffect, useState } from 'react';
import type { HelpTutorial } from '../help';

interface Step {
  kicker: string;
  title: string;
  body: string;
}

const TAB_LABEL: Record<HelpTutorial, string> = {
  compare: 'Comparar',
  variation: 'Variação',
  training: 'Treino',
};

const TUTORIALS: Record<HelpTutorial, Step[]> = {
  compare: [
    {
      kicker: 'Visão geral',
      title: 'Bem-vindo ao Prompt Builder',
      body: 'Descubra qual LLM — ou qual prompt — responde melhor. Há 3 modos: Comparar (vários modelos no mesmo desafio), Variação (um modelo, vários system prompts) e Treino (otimização iterativa do prompt). Este tutorial cobre o modo Comparar; troque de aba acima para ver os outros.',
    },
    {
      kicker: 'Passo 1',
      title: 'Monte a comparação',
      body: 'Em “Nova Run”, escreva o tema (ou use um exemplo) e escolha 2 ou mais competidores, 1 gerador (cria os cenários) e 1 juiz. O painel “Resumo da run” mostra nº de chamadas e custo estimado antes de iniciar. Concorrência e timeout ficam em “Ajustes avançados”.',
    },
    {
      kicker: 'Passo 2',
      title: 'Acompanhe ao vivo',
      body: 'Ao iniciar, você vai para a Visão da Run. As etapas abrem sozinhas e você vê cada modelo respondendo token a token, com contadores e o anel de progresso no topo.',
    },
    {
      kicker: 'Passo 3',
      title: 'Leia o resultado',
      body: 'O juiz compara as respostas em confrontos (torneio) e a aba “Resumo” traz a classificação (pontos, 1ºs, posição média, % aceitável) e o heatmap — verde é melhor, vermelho é pior. A aba “Etapas” mostra cada resposta com veredito e justificativa.',
    },
  ],
  variation: [
    {
      kicker: 'Modo Variação',
      title: 'Um modelo, vários prompts',
      body: 'Em vez de comparar modelos, você testa várias VARIAÇÕES do system prompt de UM mesmo modelo — para descobrir qual prompt funciona melhor no seu benchmark.',
    },
    {
      kicker: 'Passo 1',
      title: 'Configure as variações',
      body: 'Escolha o modelo sob teste e, opcionalmente, um prompt base. Com “Otimização de prompt” ligada, selecione técnicas (persona, chain-of-thought, restrições, formato…) — cada uma vira uma variação gerada por uma LLM. Desligada, você escreve as variações à mão.',
    },
    {
      kicker: 'Passo 2',
      title: 'Como é avaliado',
      body: 'O gerador cria as perguntas; o modelo responde com cada variação; o juiz ranqueia em confrontos às cegas. Na Visão da Run, o painel “Variantes de prompt” mostra o system prompt de cada variação, e o placar aponta a vencedora.',
    },
  ],
  training: [
    {
      kicker: 'Modo Treino',
      title: 'Auto-melhoria do prompt',
      body: 'O Treino é iterativo: a cada iteração ele pega a variação VENCEDORA, analisa onde ganhou/perdeu e gera a próxima rodada a partir dela — convergindo para um prompt melhor. O prompt original (quando fornecido) é sempre re-testado como controle.',
    },
    {
      kicker: 'Passo 1',
      title: 'Configure o treino',
      body: 'Como na Variação: modelo sob teste, prompt base opcional e técnicas. Defina também o nº de iterações. O benchmark (as perguntas) é fixado entre as iterações para comparar de forma justa.',
    },
    {
      kicker: 'Passo 2',
      title: 'Acompanhe a sessão',
      body: 'Você vai para a tela da sessão de treino: curva de melhoria por iteração, a vencedora de cada rodada e, ao final, o melhor prompt — pronto para copiar. Dá para abrir a run de cada iteração para ver os detalhes.',
    },
  ],
};

export function HelpModal({ tutorial, onClose }: { tutorial: HelpTutorial; onClose: () => void }) {
  const [active, setActive] = useState<HelpTutorial>(tutorial);
  const [step, setStep] = useState(0);

  useEffect(() => {
    setActive(tutorial);
    setStep(0);
  }, [tutorial]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const steps = TUTORIALS[active];
  const s = steps[step];
  const isLast = step >= steps.length - 1;

  function switchTab(t: HelpTutorial) {
    setActive(t);
    setStep(0);
  }
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

        <div className="tabs" style={{ marginBottom: 18 }}>
          {(Object.keys(TAB_LABEL) as HelpTutorial[]).map((t) => (
            <button
              key={t}
              type="button"
              className={`tab ${active === t ? 'active' : ''}`}
              onClick={() => switchTab(t)}
            >
              {TAB_LABEL[t]}
            </button>
          ))}
        </div>

        <span className="modal-num">{step + 1}</span>
        <div className="modal-kicker">{s.kicker}</div>
        <h2 className="modal-title">{s.title}</h2>
        <p className="modal-body">{s.body}</p>

        <div className="modal-foot">
          <div className="modal-dots">
            {steps.map((_, j) => (
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
              {isLast ? 'Fechar' : 'Próximo'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
