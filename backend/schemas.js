/**
 * Esquemas de saída estruturada (formato `responseSchema` da API Gemini,
 * subconjunto do OpenAPI 3.0 com tipos em maiúsculas).
 *
 * Os esquemas são propositalmente simples: esquemas muito profundos podem ser
 * recusados pela API. Se a API recusar o esquema, o provedor refaz a chamada
 * sem ele — o formato também está descrito em texto em cada prompt.
 */

const S = (description) => ({ type: 'STRING', ...(description ? { description } : {}) });
const I = () => ({ type: 'INTEGER' });
const B = () => ({ type: 'BOOLEAN' });
const E = (values) => ({ type: 'STRING', enum: values });
const A = (items) => ({ type: 'ARRAY', items });
const O = (properties, required = Object.keys(properties)) => ({
  type: 'OBJECT',
  properties,
  required,
  propertyOrdering: Object.keys(properties),
});

export const transcriptionSchema = O({
  segmentos: A(O({ inicio: S('MM:SS'), falante: S(), texto: S() })),
  falantes: A(
    O(
      { rotulo: S(), descricao: S(), nome_provavel: S(), evidencia_nome: S() },
      ['rotulo', 'descricao'],
    ),
  ),
  qualidade_audio: E(['boa', 'regular', 'ruim', 'sem_fala']),
  observacoes: S(),
}, ['segmentos', 'falantes', 'qualidade_audio']);

export const participantsSchema = O({
  participantes: A(
    O(
      {
        rotulo: S(),
        nome: S(),
        cargo_funcao: S(),
        instituicao: S(),
        preside: B(),
        modalidade: E(['presencial', 'remoto', 'nao_identificado']),
        confianca: E(['alta', 'media', 'baixa']),
        evidencia: S(),
      },
      ['rotulo', 'nome', 'cargo_funcao', 'preside', 'confianca'],
    ),
  ),
  mencionados_sem_fala: A(
    O(
      {
        nome: S(),
        cargo_funcao: S(),
        modalidade: E(['presencial', 'remoto', 'nao_identificado']),
        evidencia: S(),
      },
      ['nome'],
    ),
  ),
  observacoes: S(),
}, ['participantes']);

export const analysisSchema = O({
  informacoes_gerais: O(
    {
      numero: S(),
      tipo: S(),
      orgao: S(),
      data: S(),
      local: S(),
      formato: E(['presencial', 'remoto', 'hibrido', 'nao_identificado']),
      proxima_reuniao: S(),
    },
    ['formato'],
  ),
  presidencia: O({ identificacao: S(), evidencia: S() }, []),
  pauta: A(
    O(
      {
        titulo: S(),
        tipo_secao: E([
          'abertura',
          'comunicacoes_presidencia',
          'comunicacoes_secretaria',
          'momento_aberto',
          'assuntos_diversos',
          'ordem_do_dia',
          'encerramento',
          'outro',
        ]),
        segmento_inicial: I(),
        segmento_final: I(),
        resumo: S(),
        subitens: A(
          O(
            { titulo: S(), segmento_inicial: I(), segmento_final: I(), resumo: S() },
            ['titulo', 'resumo'],
          ),
        ),
      },
      ['titulo', 'tipo_secao', 'resumo'],
    ),
  ),
  processos: A(
    O(
      {
        numero: S(),
        assunto: S(),
        relator: S(),
        interessado: S(),
        segmento_inicial: I(),
        segmento_final: I(),
        situacao: S(),
      },
      ['assunto'],
    ),
  ),
  datas_e_prazos: A(O({ data_ou_prazo: S(), contexto: S(), segmento: I() }, ['data_ou_prazo'])),
  instituicoes_citadas: A(S()),
  normas_citadas: A(S()),
  pontos_incertos: A(O({ segmento: I(), descricao: S() }, ['descricao'])),
  houve_encerramento_formal: B(),
}, ['informacoes_gerais', 'pauta', 'houve_encerramento_formal']);

export const deliberationsSchema = O({
  itens: A(
    O(
      {
        tipo: E(['proposta', 'deliberacao', 'encaminhamento']),
        descricao: S(),
        autor: S(),
        responsavel: S(),
        prazo: S(),
        assunto: S(),
        segmentos: A(I()),
        citacao_literal: S(),
        fundamento: S(),
      },
      ['tipo', 'descricao', 'citacao_literal'],
    ),
  ),
});

export const momentoIdentifySchema = O({
  encontrado: B(),
  segmento_inicial: I(),
  segmento_final: I(),
  confianca: E(['alta', 'media', 'baixa']),
  evidencia: S(),
  manifestantes: A(
    O({ identificacao: S(), segmento_inicial: I(), segmento_final: I() }, ['identificacao']),
  ),
  observacao: S(),
}, ['encontrado']);

export const reviewSchema = O({
  problemas: A(
    O(
      {
        documento: E(['ata', 'momento_aberto']),
        tipo: E([
          'sem_respaldo',
          'sugestao_como_decisao',
          'dado_incorreto',
          'atribuicao_incorreta',
          'incerteza_omitida',
        ]),
        trecho: S(),
        correcao: S(),
        explicacao: S(),
        gravidade: E(['alta', 'media', 'baixa']),
      },
      ['documento', 'tipo', 'trecho', 'correcao', 'explicacao', 'gravidade'],
    ),
  ),
});
