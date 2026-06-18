import type { PromptTechnique, PublicTechnique } from './types.js';

/**
 * Biblioteca curada de tecnicas de variacao de prompt. Cada item:
 * - `good`/`bad`: por que a tecnica ajuda / quando atrapalha (mostrado na UI).
 * - `metaInstruction`: instrucao entregue ao modelo "optimizer" para reescrever
 *   o system prompt aplicando a tecnica (NAO exposta ao front).
 *
 * Base conceitual: literatura consolidada de prompt engineering
 * (The Prompt Report 2024; guias Anthropic/OpenAI).
 */
export const TECHNIQUE_LIBRARY: PromptTechnique[] = [
  {
    id: 'persona',
    name: 'Persona / papel',
    good: 'Foca tom, vocabulario e prioris do dominio; barata.',
    bad: 'Pode inflar verbosidade e gerar excesso de confianca/autoridade falsa.',
    metaInstruction:
      'Atribua ao assistente um papel/especialista explicito e adequado ao tema (ex.: "Voce e um(a) [especialista]..."). Mantenha todas as instrucoes e restricoes do prompt base.',
  },
  {
    id: 'cot',
    name: 'Chain-of-Thought',
    good: 'Forte em raciocinio, multi-etapa e logica; mais confiavel.',
    bad: 'Mais tokens/latencia/custo; pode piorar tarefas simples; raciocinio pode vazar na saida.',
    metaInstruction:
      'Acrescente instrucao para o modelo raciocinar passo a passo internamente antes de responder, entregando ao usuario apenas a resposta final (sem expor o rascunho). Preserve as instrucoes do base.',
  },
  {
    id: 'fewshot',
    name: 'Exemplos (few-shot)',
    good: 'Otimo para formato, classificacao e estilo; reduz ambiguidade.',
    bad: 'Exemplos enviesam/ancoram; consomem contexto; exigem alta qualidade.',
    metaInstruction:
      'Inclua de 1 a 3 exemplos curtos e representativos de entrada->saida ideal, coerentes com o tema e o contexto, demonstrando o comportamento desejado. Preserve as instrucoes do base.',
  },
  {
    id: 'format',
    name: 'Formato de saida explicito',
    good: 'Respostas previsiveis, parseaveis e completas; menos omissoes.',
    bad: 'Rigidez pode suprimir nuance; modelo pode forcar encaixe.',
    metaInstruction:
      'Especifique um formato de saida explicito e adequado a tarefa (secoes, campos, bullets ou estrutura). Deixe claro o que cada parte deve conter. Preserve as instrucoes do base.',
  },
  {
    id: 'constraints',
    name: 'Restricoes / guardrails',
    good: 'Mais seguro e on-policy (critico em dominio regulado/clinico).',
    bad: 'Excesso de restricoes pode gerar recusas inuteis; prompt mais longo.',
    metaInstruction:
      'Adicione restricoes e regras explicitas: o que fazer e o que NAO fazer, limites de escopo, e quando recusar ou encaminhar a um humano. Preserve a intencao do base.',
  },
  {
    id: 'decompose',
    name: 'Decomposicao em subpassos',
    good: 'Melhor cobertura e completude em tarefas complexas.',
    bad: 'Verbosidade; overhead em tarefas simples; pode ficar rigido.',
    metaInstruction:
      'Instrua o modelo a decompor a tarefa em subpassos explicitos e aborda-los em ordem antes de consolidar a resposta. Preserve as instrucoes do base.',
  },
  {
    id: 'selfcritique',
    name: 'Autocritica / revisao',
    good: 'Pega erros e melhora factualidade; bom para alto risco.',
    bad: '~2x tokens/latencia; pode "consertar" o que ja estava correto.',
    metaInstruction:
      'Acrescente instrucao para o modelo, internamente, gerar uma resposta, revisa-la criticamente em busca de erros e entregar apenas a versao corrigida. Preserve as instrucoes do base.',
  },
  {
    id: 'specificity',
    name: 'Especificidade / criterios',
    good: 'Menos ambiguidade; respostas mais alinhadas ao objetivo.',
    bad: 'Prompt mais longo; risco de injetar premissas erradas.',
    metaInstruction:
      'Enriqueca o prompt com criterios de sucesso, publico-alvo, definicoes relevantes e nivel de detalhe esperado. Seja especifico sem mudar a intencao do base.',
  },
  {
    id: 'delimiters',
    name: 'Delimitadores / secoes',
    good: 'Separa instrucao de dado (reduz confusao e injecao); clareza.',
    bad: 'Ganho pequeno em prompts ja claros; pode ser apenas cosmetico.',
    metaInstruction:
      'Reorganize o prompt com secoes e delimitadores claros separando instrucoes, contexto e dados (ex.: titulos ou marcadores). Preserve o conteudo do base.',
  },
  {
    id: 'concise',
    name: 'Conciso / imperativo',
    good: 'Menos distracao, menor custo; bom contraste de baseline.',
    bad: 'Pode descartar contexto util; subespecifica edge cases.',
    metaInstruction:
      'Reescreva o prompt de forma concisa e imperativa, mantendo apenas o essencial e removendo redundancia. Preserve a intencao e as restricoes do base.',
  },
  {
    id: 'emphasis',
    name: 'Realcar instrucoes-chave',
    good: 'Combate "lost in the middle"; reforca regras obrigatorias.',
    bad: 'Duplicacao/verbosidade; marginal em prompts curtos.',
    metaInstruction:
      'Reposicione e reforce as instrucoes criticas no inicio e no fim do prompt, destacando claramente o que e obrigatorio. Preserve o conteudo do base.',
  },
  {
    id: 'positive',
    name: 'Reframe positivo',
    good: 'Modelos seguem melhor instrucoes positivas que negacoes.',
    bad: 'Pode alongar; algumas restricoes sao naturalmente negativas.',
    metaInstruction:
      'Converta proibicoes e instrucoes negativas em instrucoes positivas equivalentes (o que FAZER em vez do que evitar), sem perder nenhuma restricao do base.',
  },
];

export function listTechniques(): PublicTechnique[] {
  return TECHNIQUE_LIBRARY.map(({ metaInstruction: _omit, ...rest }) => rest);
}

export function getTechnique(id: string): PromptTechnique | undefined {
  return TECHNIQUE_LIBRARY.find((t) => t.id === id);
}
