import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseModelJson } from '../backend/json-utils.js';
import { MODELO_MOMENTO_ABERTO, parseDateBr } from '../backend/prompts.js';
import {
  applyReviewFixes,
  checkNames,
  checkNumbers,
  countDeliberationLines,
  numbersFromWords,
  sanitizeDocumentText,
  validateMomentoFormat,
  verifyItems,
  verifyQuote,
} from '../backend/quality.js';
import { hasRepetitionLoop } from '../backend/tasks.js';
import { displayName, formatTime, parseTimestamp } from '../backend/transcript.js';

const SEGMENTS = [
  { id: 1, start: 0, speaker: 'Falante 1', text: 'Boa tarde. Eu sugiro que façamos um comunicado para orientar a carreira.' },
  { id: 2, start: 20, speaker: 'Falante 2', text: 'Sobre a prorrogação do processo CI 16.411, todos de acordo?' },
  { id: 3, start: 40, speaker: 'Falante 1', text: 'De acordo. Então fica aprovada a prorrogação da análise por mais uma vez.' },
  { id: 4, start: 60, speaker: 'Falante 3', text: 'A Mariela se prontificou a redigir o comunicado até o dia vinte e nove de janeiro.' },
];

test('JSON tolerante: cercas de código, texto ao redor e saída truncada', () => {
  assert.deepEqual(parseModelJson('```json\n{"a":1}\n```').value, { a: 1 });
  assert.deepEqual(parseModelJson('Segue: {"a":[1,2]} Espero ter ajudado.').value, { a: [1, 2] });
  const truncated = parseModelJson('{"segmentos":[{"t":"um"},{"t":"dois"},{"t":"tr');
  assert.equal(truncated.repaired, true);
  assert.equal(truncated.value.segmentos.length, 2);
  assert.throws(() => parseModelJson('sem json'));
});

test('citação literal existente é confirmada; citação inventada não é', () => {
  assert.equal(verifyQuote('Então fica aprovada a prorrogação da análise por mais uma vez', SEGMENTS, [3]).found, true);
  // pequenas diferenças de pontuação/acentuação não impedem a confirmação
  assert.equal(verifyQuote('entao fica aprovada a prorrogacao da analise, por mais uma vez!', SEGMENTS, [3]).found, true);
  assert.equal(verifyQuote('o comunicado foi aprovado por todos os membros presentes na reunião', SEGMENTS, [1]).found, false);
  assert.equal(verifyQuote('de acordo', SEGMENTS, [3]).found, false, 'citações curtas demais não comprovam nada');
});

test('sugestão NÃO vira decisão: deliberação sem comprovação é rebaixada a proposta', () => {
  const items = verifyItems(
    [
      { tipo: 'deliberacao', descricao: 'Aprovada a prorrogação da análise.', segmentos: [3], citacao_literal: 'Então fica aprovada a prorrogação da análise por mais uma vez.' },
      { tipo: 'deliberacao', descricao: 'Aprovada a elaboração de comunicado.', segmentos: [1], citacao_literal: 'ficou aprovado que a comissão fará um comunicado à carreira' },
      { tipo: 'encaminhamento', descricao: 'Mariela redigirá o comunicado.', segmentos: [4, 999], citacao_literal: 'A Mariela se prontificou a redigir o comunicado' },
    ],
    SEGMENTS,
  );
  assert.equal(items[0].type, 'deliberacao');
  assert.equal(items[0].verified, true);
  assert.equal(items[1].type, 'proposta');
  assert.equal(items[1].downgraded, true);
  assert.equal(items[2].type, 'encaminhamento');
  assert.deepEqual(items[2].segments, [4], 'segmentos inexistentes são descartados');
});

test('formato do Momento Aberto: o modelo de referência é aceito', () => {
  assert.deepEqual(validateMomentoFormat(MODELO_MOMENTO_ABERTO), []);
});

test('formato do Momento Aberto: roteiro, colchetes, marcadores e respostas telegráficas são reprovados', () => {
  const script = [
    'MOMENTO ABERTO – 906ª SESSÃO ORDINÁRIA DO CONSELHO SUPERIOR 12/12/2025',
    '',
    '[Presidente]',
    'Willian Fernandes: Homenageou Vitor Hugo e falou sobre sua importância.',
    'Dra. Vivian Peres da Silva (IDDD): Falou sobre participação social.',
    '- Pediu reconsideração.',
    'Presidente: Agradeceu.',
  ].join('\n');
  const problems = validateMomentoFormat(script);
  assert.equal(problems.length, 4);
  assert.match(problems.join(' '), /colchetes/);
  assert.match(problems.join(' '), /"Nome: fala"/);
  assert.match(problems.join(' '), /marcadores/);
  assert.match(problems.join(' '), /telegráficos/);
});

test('formato do Momento Aberto: dois-pontos dentro da narrativa não é falso positivo', () => {
  const ok = [
    'MOMENTO ABERTO – 10ª SESSÃO ORDINÁRIA DO CONSELHO 01/02/2026',
    '',
    'Representante da Sociedade Civil, Ana Souza apresenta três pontos: a falta de intérpretes, o horário de atendimento e a demora nas respostas. Ela pede providências.',
    '',
    'Presidente: agradeceu a manifestação e informou que o tema será encaminhado à coordenadoria responsável.',
  ].join('\n');
  assert.deepEqual(validateMomentoFormat(ok), []);
  assert.equal(validateMomentoFormat('Relato sem cabeçalho').length, 1);
});

test('números por extenso são reconhecidos', () => {
  const has = (text, n) => assert.ok(numbersFromWords(text).has(String(n)), `${text} -> ${n}`);
  has('dia vinte e nove de janeiro', 29);
  has('dois mil e vinte e cinco', 2025);
  has('ato trezentos e dezoito', 318);
  has('processo dezesseis mil quatrocentos e onze', 16411);
  has('nonagésima segunda reunião', 92);
  has('nongentésima sexta sessão', 906);
  has('processo um seis quatro um um', 16411);
  has('prazo de sessenta dias', 60);
  has('cento e vinte famílias', 120);
  has('mil novecentos e oitenta e oito', 1988);
});

test('conferência de números: aponta apenas o que não está nas fontes', () => {
  const sources = `${SEGMENTS.map((s) => s.text).join('\n')}\nData: 11/12/2025`;
  const ata = [
    'ATA DA 92ª REUNIÃO',
    'Data: 11 de dezembro de 2025',
    '5.1. Processo CI 16.411 – Prorrogação',
    'O comunicado será redigido até 29 de janeiro. O processo 77.123 foi citado.',
  ].join('\n');
  assert.deepEqual(checkNumbers(ata, sources), ['92', '77.123']);
  assert.deepEqual(checkNumbers(ata, `${sources}\nNúmero: 92ª\nprocesso 77.123`), []);
});

test('conferência de nomes: nome ausente das fontes é apontado', () => {
  const sources = 'a mariela se prontificou a redigir. o doutor luciano concordou. defensoria publica';
  const doc = 'A relatora Mariela informou que o Dr. Luciano e o membro Rodrigo concordaram. A Defensoria Pública foi citada.';
  assert.deepEqual(checkNames(doc, sources), ['Rodrigo']);
});

test('correções da revisão: aplica só quando o trecho é inequívoco', () => {
  const doc = 'Os membros aprovaram a proposta por unanimidade e com louvor.\nDeliberação: Aprovado.\nO tema voltará à pauta. O tema voltará à pauta.';
  const { text, applied, pending } = applyReviewFixes(doc, [
    { document: 'ata', excerpt: ' por unanimidade e com louvor', replacement: '', severity: 'alta' },
    { document: 'ata', excerpt: 'O tema voltará à pauta.', replacement: '', severity: 'alta' },
    { document: 'ata', excerpt: 'trecho inexistente no texto', replacement: 'x', severity: 'alta' },
    { document: 'ata', excerpt: 'Deliberação: Aprovado.', replacement: 'y', severity: 'baixa' },
  ]);
  assert.match(text, /^Os membros aprovaram a proposta\.$/m);
  assert.equal(applied.length, 1);
  assert.equal(pending.length, 3);
  assert.equal(countDeliberationLines(text), 1);
});

test('limpeza de Markdown preserva o conteúdo', () => {
  const dirty = '```\n# ATA DA REUNIÃO\n\n**Deliberação:** Aprovado.\n\n\n\n- item *destacado* aqui\n```';
  assert.equal(sanitizeDocumentText(dirty), 'ATA DA REUNIÃO\n\nDeliberação: Aprovado.\n\nitem destacado aqui');
});

test('utilidades: datas, tempos, nomes de exibição e laço de repetição', () => {
  assert.deepEqual(parseDateBr('11/12/2025'), { numerica: '11/12/2025', extenso: '11 de dezembro de 2025' });
  assert.deepEqual(parseDateBr('1/5/26'), { numerica: '01/05/2026', extenso: '1º de maio de 2026' });
  assert.equal(parseDateBr('31/02/2025').extenso, '31/02/2025', 'data inválida não é "corrigida"');
  assert.equal(parseTimestamp('01:02:03'), 3723);
  assert.equal(parseTimestamp('12:34'), 754);
  assert.equal(parseTimestamp('abc'), null);
  assert.equal(formatTime(3723), '01:02:03');
  assert.equal(displayName({ name: 'Michel', role: 'Secretário' }, 'Falante 2'), 'Michel — Secretário');
  assert.equal(displayName({ name: '', role: 'Membro da Comissão' }, 'Falante 3'), 'Membro da Comissão');
  assert.equal(displayName({ name: '', role: '', institution: '' }, 'Falante 4'), 'Participante não identificado (Falante 4)');
  assert.equal(displayName({ name: '', role: '', presides: true }, 'Falante 1'), 'Presidente — Participante não identificado (Falante 1)');
  assert.equal(hasRepetitionLoop('muito obrigado a todos '.repeat(40)), true);
  assert.equal(hasRepetitionLoop('A comissão discutiu a pauta e deliberou sobre os processos do dia.'), false);
});
