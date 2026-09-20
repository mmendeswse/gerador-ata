/**
 * Provedor SIMULADO (AI_PROVIDER=mock).
 *
 * Não chama nenhum serviço externo e não usa o áudio recebido: devolve uma
 * reunião FICTÍCIA e fixa. Serve para validar a instalação e testar a
 * interface de ponta a ponta sem chave de API e sem custo.
 *
 * MOCK_SCENARIO (lista separada por vírgulas) simula situações de erro nos
 * testes automatizados: rate_limit_once, truncate_first, script_format,
 * unavailable_once.
 */

import { Errors } from '../errors.js';
import { parseDateBr } from '../prompts.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SCRIPT = [
  ['Falante 1', 'Boa tarde a todas e a todos. Este é o modo de teste do sistema, com uma reunião fictícia. Agradeço a presença e declaro aberta a reunião ordinária da comissão.'],
  ['Falante 1', 'Antes da pauta, vamos ao momento aberto. Temos uma inscrita: a senhora Marta Ribeiro, representante da Associação de Moradores do Jardim das Acácias. A senhora tem a palavra.'],
  ['Falante 4', 'Boa tarde. Eu sou Marta Ribeiro, da Associação de Moradores do Jardim das Acácias. Venho relatar que o atendimento itinerante previsto para o nosso bairro foi suspenso em março, sem aviso às famílias.'],
  ['Falante 4', 'Mais de duzentas famílias dependem desse atendimento, muitas sem condições de pagar transporte até o centro. Protocolamos um ofício no dia 3 de abril e até hoje não recebemos resposta.'],
  ['Falante 4', 'Por isso, peço respeitosamente que a comissão avalie a retomada do atendimento itinerante e que a associação seja ouvida na definição do novo calendário.'],
  ['Falante 1', 'Agradeço a participação da senhora Marta Ribeiro. Informo que o ofício será localizado pela secretaria e que o tema do atendimento itinerante será incluído na pauta da próxima reunião.'],
  ['Falante 1', 'Encerrado o momento aberto, passo às comunicações. Helena, por favor, as comunicações da secretaria.'],
  ['Falante 2', 'Obrigada, presidente. Pela secretaria, informo que recebemos doze novos expedientes neste mês e que o relatório semestral será distribuído aos membros até o dia 20.'],
  ['Falante 1', 'Obrigado, Helena. Passamos à ordem do dia. Processo 45.210, que trata da padronização dos formulários de atendimento. Relator, Otávio.'],
  ['Falante 3', 'Obrigado. No processo 45.210, analisei os três modelos de formulário em uso. Há divergência de campos entre as unidades, o que dificulta a consolidação dos dados.'],
  ['Falante 3', 'Proponho a adoção do modelo unificado que está no anexo 2, com prazo de sessenta dias para a transição das unidades.'],
  ['Falante 5', 'Eu sugiro que a gente faça também um comunicado para orientar as unidades sobre a mudança.'],
  ['Falante 1', 'Anotada a sugestão do comunicado. Sobre a proposta do relator, de adoção do modelo unificado com transição em sessenta dias: todos de acordo?'],
  ['Falante 2', 'De acordo.'],
  ['Falante 3', 'De acordo.'],
  ['Falante 1', 'Então fica aprovada a adoção do modelo unificado de formulário, com prazo de sessenta dias para a transição.'],
  ['Falante 2', 'Presidente, eu me prontifico a redigir a minuta do ofício às unidades até sexta-feira.'],
  ['Falante 1', 'Ótimo, Helena fica responsável pela minuta. A próxima reunião fica sugerida para o dia 14 de maio. Não havendo mais assuntos, declaro encerrada a reunião. Obrigado a todos.'],
];

let transcribeCalls = 0;
const firedScenarios = new Set();

function scenarioActive(config, name) {
  return config.mockScenario.split(',').map((s) => s.trim()).includes(name);
}

function fireOnce(config, name) {
  if (!scenarioActive(config, name) || firedScenarios.has(name)) return false;
  firedScenarios.add(name);
  return true;
}

function headerParts(info = {}) {
  const number = (info.number || '').trim();
  const numberText = number ? (/[ªº]$/.test(number) ? number : `${number}ª`) : '';
  const type = (info.type || 'Reunião Ordinária').trim().toUpperCase();
  const body = (info.body || 'Comissão de Exemplo').trim().toUpperCase();
  const article = /^(CONSELHO|COMIT[ÊE]|COLEGIADO|GRUPO|N[ÚU]CLEO|TRIBUNAL|PLEN[ÁA]RIO|F[ÓO]RUM)/.test(body)
    ? 'DO'
    : 'DA';
  const date = info.date ? parseDateBr(info.date) : null;
  return { numberText, type, body, article, date };
}

function mockParticipants(info = {}) {
  return {
    participantes: [
      { rotulo: 'Falante 1', nome: info.president || '', cargo_funcao: 'Presidente', instituicao: '', preside: true, modalidade: 'presencial', confianca: 'alta', evidencia: '#1: abre a reunião; #18: declara o encerramento' },
      { rotulo: 'Falante 2', nome: 'Helena', cargo_funcao: 'Secretária', instituicao: '', preside: false, modalidade: 'presencial', confianca: 'alta', evidencia: '#7: "Helena, por favor, as comunicações da secretaria"' },
      { rotulo: 'Falante 3', nome: 'Otávio', cargo_funcao: 'Membro da Comissão (relator)', instituicao: '', preside: false, modalidade: 'presencial', confianca: 'alta', evidencia: '#9: "Relator, Otávio"' },
      { rotulo: 'Falante 4', nome: 'Marta Ribeiro', cargo_funcao: 'Representante da Associação de Moradores do Jardim das Acácias', instituicao: 'Associação de Moradores do Jardim das Acácias', preside: false, modalidade: 'presencial', confianca: 'alta', evidencia: '#3: "Eu sou Marta Ribeiro, da Associação de Moradores do Jardim das Acácias"' },
      { rotulo: 'Falante 5', nome: '', cargo_funcao: '', instituicao: '', preside: false, modalidade: 'nao_identificado', confianca: 'baixa', evidencia: '' },
    ],
    mencionados_sem_fala: [],
    observacoes: 'Identificação simulada (modo de teste).',
  };
}

function mockAnalysis() {
  return {
    informacoes_gerais: { numero: '', tipo: 'reunião ordinária', orgao: '', data: '', local: '', formato: 'nao_identificado', proxima_reuniao: '14 de maio (sugerida)' },
    presidencia: { identificacao: 'Falante 1', evidencia: '#1 abre a reunião e #18 a encerra' },
    pauta: [
      { titulo: 'Abertura', tipo_secao: 'abertura', segmento_inicial: 1, segmento_final: 1, resumo: 'A Presidência agradeceu a presença e abriu a reunião ordinária.', subitens: [] },
      { titulo: 'Momento aberto', tipo_secao: 'momento_aberto', segmento_inicial: 2, segmento_final: 6, resumo: 'Marta Ribeiro relatou a suspensão do atendimento itinerante e pediu sua retomada; a Presidência respondeu.', subitens: [] },
      { titulo: 'Comunicações da Secretaria', tipo_secao: 'comunicacoes_secretaria', segmento_inicial: 7, segmento_final: 8, resumo: 'Doze novos expedientes; relatório semestral até o dia 20.', subitens: [] },
      { titulo: 'Ordem do dia', tipo_secao: 'ordem_do_dia', segmento_inicial: 9, segmento_final: 17, resumo: 'Processo 45.210 — padronização dos formulários de atendimento.', subitens: [] },
      { titulo: 'Encerramento', tipo_secao: 'encerramento', segmento_inicial: 18, segmento_final: 18, resumo: 'Próxima reunião sugerida para 14 de maio; encerramento.', subitens: [] },
    ],
    processos: [{ numero: '45.210', assunto: 'Padronização dos formulários de atendimento', relator: 'Otávio', interessado: '', segmento_inicial: 9, segmento_final: 17, situacao: 'Aprovada a adoção do modelo unificado' }],
    datas_e_prazos: [
      { data_ou_prazo: '3 de abril', contexto: 'protocolo do ofício da associação', segmento: 4 },
      { data_ou_prazo: 'dia 20', contexto: 'distribuição do relatório semestral', segmento: 8 },
      { data_ou_prazo: '14 de maio', contexto: 'próxima reunião (sugerida)', segmento: 18 },
    ],
    instituicoes_citadas: ['Associação de Moradores do Jardim das Acácias'],
    normas_citadas: [],
    pontos_incertos: [],
    houve_encerramento_formal: true,
  };
}

function mockDeliberations() {
  return {
    itens: [
      { tipo: 'deliberacao', descricao: 'Aprovada a adoção do modelo unificado de formulário de atendimento, com prazo de sessenta dias para a transição das unidades.', autor: 'Otávio', responsavel: '', prazo: 'sessenta dias', assunto: 'Processo 45.210', segmentos: [13, 16], citacao_literal: 'Então fica aprovada a adoção do modelo unificado de formulário, com prazo de sessenta dias para a transição.', fundamento: 'A Presidência consultou o colegiado e proclamou a aprovação.' },
      // Citação propositalmente inexistente: demonstra o rebaixamento automático para "proposta".
      { tipo: 'deliberacao', descricao: 'Elaboração de comunicado para orientar as unidades sobre a mudança de formulário.', autor: 'Participante não identificado', responsavel: '', prazo: '', assunto: 'Processo 45.210', segmentos: [12], citacao_literal: 'o comunicado foi aprovado por todos os membros da comissão nesta data', fundamento: 'Simulação de classificação indevida.' },
      { tipo: 'encaminhamento', descricao: 'Helena se prontificou a redigir a minuta do ofício às unidades até sexta-feira.', autor: 'Helena', responsavel: 'Helena', prazo: 'até sexta-feira', assunto: 'Processo 45.210', segmentos: [17], citacao_literal: 'eu me prontifico a redigir a minuta do ofício às unidades até sexta-feira', fundamento: 'Providência com responsável e prazo.' },
      { tipo: 'encaminhamento', descricao: 'Inclusão do tema do atendimento itinerante na pauta da próxima reunião.', autor: 'Presidente', responsavel: 'Secretaria', prazo: 'próxima reunião', assunto: 'Momento aberto', segmentos: [6], citacao_literal: 'o tema do atendimento itinerante será incluído na pauta da próxima reunião', fundamento: 'Providência anunciada pela Presidência.' },
    ],
  };
}

function mockAta(info) {
  const { numberText, type, body, article, date } = headerParts(info);
  const title = ['ATA DA', numberText, type, article, body].filter(Boolean).join(' ');
  const president = info?.president ? info.president : '[Presidente não nomeado]';
  const lines = [title];
  if (date) lines.push(`Data: ${date.extenso}`);
  if (info?.location) lines.push(`Local: ${info.location}`);
  lines.push(`Membros Presentes: ${president}, Helena, Otávio.`);
  lines.push(
    '',
    '1. ABERTURA',
    '',
    'O Presidente agradeceu a presença de todos e declarou aberta a reunião ordinária.',
    '',
    '2. MOMENTO ABERTO',
    '',
    'A senhora Marta Ribeiro, representante da Associação de Moradores do Jardim das Acácias, relatou a suspensão, em março, do atendimento itinerante no bairro, informou o protocolo de ofício em 3 de abril, ainda sem resposta, e solicitou a retomada do serviço, com a oitiva da associação na definição do novo calendário. O Presidente agradeceu a manifestação e informou que o ofício será localizado pela Secretaria e que o tema será incluído na pauta da próxima reunião.',
    '',
    '3. COMUNICAÇÕES DA SECRETARIA',
    '',
    'A Secretária Helena informou o recebimento de doze novos expedientes no mês e que o relatório semestral será distribuído aos membros até o dia 20.',
    '',
    '4. ORDEM DO DIA',
    '',
    '4.1. Processo 45.210 – Padronização dos Formulários de Atendimento (Relator: Otávio)',
    'O relator informou ter analisado os três modelos de formulário em uso e apontou divergência de campos entre as unidades, o que dificulta a consolidação dos dados. Propôs a adoção do modelo unificado constante do anexo 2, com prazo de sessenta dias para a transição. Um dos participantes sugeriu a elaboração de comunicado para orientar as unidades, sugestão que foi anotada pela Presidência. Consultado o colegiado, os membros manifestaram concordância com a proposta do relator por unanimidade e com louvor.',
    'Deliberação: Aprovada a adoção do modelo unificado de formulário de atendimento, com prazo de sessenta dias para a transição.',
    'Helena se prontificou a redigir a minuta do ofício às unidades até sexta-feira.',
    '',
    '5. ENCERRAMENTO',
    '',
    'A próxima reunião foi sugerida para o dia 14 de maio. Não havendo mais assuntos a serem tratados, a reunião foi declarada encerrada.',
    '',
    '(Documento gerado em MODO DE TESTE, com conteúdo fictício. Configure a chave da API no servidor para processar reuniões reais.)',
  );
  return lines.join('\n');
}

function mockMomento(info, { scriptFormat = false } = {}) {
  const { numberText, type, body, article, date } = headerParts(info);
  const header = ['MOMENTO ABERTO –', numberText, type, article, body, date?.numerica]
    .filter(Boolean)
    .join(' ');

  if (scriptFormat) {
    return [
      header,
      '',
      '[Presidente]',
      'Marta Ribeiro: Falou sobre o atendimento itinerante.',
      'Presidente: Agradeceu.',
    ].join('\n');
  }

  return [
    header,
    '',
    'Representante da Associação de Moradores do Jardim das Acácias, Marta Ribeiro relata que o atendimento itinerante previsto para o bairro foi suspenso em março, sem aviso às famílias. Ela destaca que mais de duzentas famílias dependem desse atendimento, muitas sem condições de arcar com o transporte até o centro, e informa que a associação protocolou um ofício no dia 3 de abril, ainda sem resposta. Por fim, pede respeitosamente que a comissão avalie a retomada do atendimento itinerante e que a associação seja ouvida na definição do novo calendário.',
    '',
    'Presidente: agradeceu a participação da senhora Marta Ribeiro, informou que o ofício será localizado pela Secretaria e que o tema do atendimento itinerante será incluído na pauta da próxima reunião.',
    '',
    '(Documento gerado em MODO DE TESTE, com conteúdo fictício.)',
  ].join('\n');
}

export function createMockProvider(config) {
  const wait = () => sleep(config.mockDelayMs);

  return {
    name: 'mock',

    async transcribe({ context }) {
      await wait();
      transcribeCalls += 1;
      if (fireOnce(config, 'rate_limit_once')) throw Errors.aiRateLimit(2);

      const meta = context.meta;
      const total = meta.totalChunks;
      const index = Math.min(meta.chunkIndex, total - 1);
      const from = Math.floor((index * SCRIPT.length) / total);
      const to = Math.floor(((index + 1) * SCRIPT.length) / total);
      const slice = SCRIPT.slice(from, to);
      const duration = Math.max(1, meta.endSeconds - meta.startSeconds);

      const labels = [...new Set(slice.map(([speaker]) => speaker))];
      const body = {
        segmentos: slice.map(([speaker, text], i) => {
          const at = Math.floor((i / Math.max(1, slice.length)) * duration);
          const mm = String(Math.floor(at / 60)).padStart(2, '0');
          const ss = String(at % 60).padStart(2, '0');
          return { inicio: `${mm}:${ss}`, falante: speaker, texto: text };
        }),
        falantes: labels.map((label) => ({
          rotulo: label,
          descricao: 'voz simulada (modo de teste)',
          nome_provavel: '',
          evidencia_nome: '',
        })),
        qualidade_audio: 'boa',
        observacoes: 'Transcrição simulada (modo de teste).',
      };

      const truncated = fireOnce(config, 'truncate_first');
      return {
        text: JSON.stringify(body),
        finishReason: truncated ? 'MAX_TOKENS' : 'STOP',
        truncated,
        partiallyBlocked: false,
        model: 'simulado',
        usage: { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, totalTokens: 0, calls: transcribeCalls },
      };
    },

    async generateJson({ purpose, context }) {
      await wait();
      if (purpose === 'analysis' && fireOnce(config, 'unavailable_once')) throw Errors.aiUnavailable();

      let body;
      if (purpose === 'participants') body = mockParticipants(context.meetingInfo);
      else if (purpose === 'analysis') body = mockAnalysis();
      else if (purpose === 'deliberations') body = mockDeliberations();
      else if (purpose === 'momento_identify') {
        body = {
          encontrado: true,
          segmento_inicial: 2,
          segmento_final: 7,
          confianca: 'alta',
          evidencia: '#2: "Antes da pauta, vamos ao momento aberto."',
          manifestantes: [{ identificacao: 'Marta Ribeiro', segmento_inicial: 3, segmento_final: 5 }],
          observacao: '',
        };
      } else if (purpose === 'review') {
        body = {
          problemas: context.documents?.ata
            ? [
                {
                  documento: 'ata',
                  tipo: 'sem_respaldo',
                  trecho: ' por unanimidade e com louvor',
                  correcao: '',
                  explicacao: 'A transcrição (#13 a #16) registra concordância, mas não menciona unanimidade nem louvor.',
                  gravidade: 'media',
                },
              ]
            : [],
        };
      } else {
        throw Errors.badRequest(`Finalidade simulada desconhecida: ${purpose}`);
      }
      return { text: JSON.stringify(body), finishReason: 'STOP', truncated: false, partiallyBlocked: false, model: 'simulado', usage: {} };
    },

    async generateText({ purpose, context }) {
      await wait();
      let text;
      if (purpose === 'ata') text = mockAta(context.meetingInfo);
      else if (purpose === 'momento') {
        const scriptFormat = !context.corrective && fireOnce(config, 'script_format');
        text = mockMomento(context.meetingInfo, { scriptFormat });
      } else throw Errors.badRequest(`Finalidade simulada desconhecida: ${purpose}`);

      return { text, finishReason: 'STOP', truncated: false, partiallyBlocked: false, model: 'simulado', usage: {} };
    },
  };
}

/** Usado somente pelos testes automatizados. */
export function resetMockState() {
  transcribeCalls = 0;
  firedScenarios.clear();
}
