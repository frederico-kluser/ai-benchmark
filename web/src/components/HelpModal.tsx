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

// Tutoriais curtos: 3 passos por modo (o que é / o que selecionar / como ler).
// Devem refletir a tela atual — página única de configuração + heatmap ao vivo +
// bloco "Final" com os 3 melhores duelando.
const TUTORIALS: Record<HelpTutorial, Step[]> = {
  compare: [
    {
      kicker: 'O que é',
      title: 'Vários modelos, os mesmos cenários',
      body: 'Todos os modelos respondem às mesmas perguntas. Um gabarito é escrito antes, e o juiz compara cada resposta com ele: resolve, parcial ou não resolve.',
    },
    {
      kicker: 'O que selecionar',
      title: 'Cenários, modelos e juízes',
      body: 'Importe um JSON de cenários ou mande gerar (escolhendo a LLM geradora e quantos). Escolha os modelos que competem e ao menos 1 juiz. Se o JSON já trouxer tudo, só falta o juiz.',
    },
    {
      kicker: 'Como ler',
      title: 'Heatmap e final',
      body: 'Enquanto roda, o heatmap preenche cenário × modelo: ✓ resolve, ◐ parcial, ✕ não resolve. No fim, os 3 de maior score duelam entre si em cada cenário e o pódio sai em “Final”.',
    },
  ],
  variation: [
    {
      kicker: 'O que é',
      title: 'Um modelo, vários prompts',
      body: 'O modelo é fixo e o que muda é o system prompt. Cada variação enfrenta os mesmos cenários para você descobrir qual prompt funciona melhor.',
    },
    {
      kicker: 'O que selecionar',
      title: 'Prompt base, variações e juízes',
      body: 'Escolha o modelo sob teste, escreva (ou gere) o prompt base e marque as técnicas que viram variações — o botão “Todas” seleciona de uma vez. Depois, os juízes.',
    },
    {
      kicker: 'Como ler',
      title: 'Heatmap e final',
      body: 'O heatmap mostra cada variação em cada cenário. Em “Final”, as 3 melhores duelam entre si; o bloco “Variantes” guarda o texto de cada prompt.',
    },
  ],
  training: [
    {
      kicker: 'O que é',
      title: 'O prompt evolui sozinho',
      body: 'A cada rodada a melhor variação vira a base da próxima. Os cenários são congelados entre as rodadas, e o treino para quando não há mais ganho real.',
    },
    {
      kicker: 'O que selecionar',
      title: 'Igual à variação, mais rodadas',
      body: 'Modelo sob teste, prompt base, técnicas, juízes — e quantas rodadas de evolução. Uma fatia dos cenários fica reservada para validar o campeão no fim.',
    },
    {
      kicker: 'Como ler',
      title: 'Rodada, evolução e melhor prompt',
      body: 'O heatmap acompanha a rodada corrente e “Evolução” mostra o score de cada variante por rodada. Em “Melhor prompt” você compara com o original, copia e salva na biblioteca.',
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
