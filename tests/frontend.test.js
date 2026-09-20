// Testes das partes da interface que não dependem do navegador (módulos puros).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseDocument, splitMarks } from '../docs/js/lib/docmodel.js';
import { describeError, AppError, toAppError } from '../docs/js/lib/errors.js';
import { buildFileName, formatBytes, formatClock, formatDuration, isValidDateBr, maskDate } from '../docs/js/lib/format.js';
import { planCuts } from '../docs/js/services/audio.js';
import { buildDocx } from '../docs/js/services/docx.js';
import { normalizeApiBase } from '../docs/js/settings.js';

test('nomes de arquivo seguem o padrão pedido', () => {
  const info = { number: '92ª', date: '11/12/2025' };
  assert.equal(buildFileName('ata', info, 'txt'), 'Ata_Reuniao_92_11-12-2025.txt');
  assert.equal(buildFileName('ata', info, 'docx'), 'Ata_Reuniao_92_11-12-2025.docx');
  assert.equal(buildFileName('momento', { number: '906', date: '12/12/2025' }, 'docx'), 'Momento_Aberto_906_12-12-2025.docx');
  assert.equal(buildFileName('ata', {}, 'txt'), 'Ata_Reuniao.txt');
  assert.equal(buildFileName('ata', { number: '../../x', date: '' }, 'txt'), 'Ata_Reuniao_x.txt', 'caracteres perigosos são removidos');
});

test('datas, tamanhos e tempos', () => {
  assert.equal(maskDate('11122025'), '11/12/2025');
  assert.equal(maskDate('1a1/1'), '11/1');
  assert.equal(isValidDateBr('29/02/2024'), true);
  assert.equal(isValidDateBr('31/02/2025'), false);
  assert.equal(isValidDateBr('1/2/2025'), false);
  assert.equal(formatClock(3723), '01:02:03');
  assert.equal(formatDuration(6300), '1h 45min');
  assert.equal(formatDuration(500), '8min 20s');
  assert.match(formatBytes(1288490188), /^1,20? GB$/);
});

test('endereço do servidor é normalizado', () => {
  assert.equal(normalizeApiBase(' https://x.vercel.app/ '), 'https://x.vercel.app');
  assert.equal(normalizeApiBase('https://x.vercel.app/api/'), 'https://x.vercel.app');
  assert.equal(normalizeApiBase('x.vercel.app'), 'https://x.vercel.app');
  assert.equal(normalizeApiBase('http://localhost:3000'), 'http://localhost:3000');
  assert.equal(normalizeApiBase(''), '');
});

test('cortes do áudio caem no meio das pausas mais longas', () => {
  const silences = [
    { start: 590, end: 590.5 }, // pausa curta perto do alvo
    { start: 612, end: 615 }, // pausa longa dentro da janela -> escolhida (meio = 613,5)
    { start: 900, end: 905 }, // fora da janela do 1º corte
    { start: 1210, end: 1211 },
  ];
  assert.deepEqual(planCuts(1800, 600, silences), [613.5, 1210.5]);
  assert.deepEqual(planCuts(700, 600, silences), [], 'reunião curta: trecho único');
  assert.deepEqual(planCuts(1300, 600, []), [600], 'sem pausas detectadas: corte no tempo exato');
  // o último trecho nunca fica minúsculo (até 25% a mais é incorporado ao anterior)
  assert.deepEqual(planCuts(1340, 600, []), [600]);
});

test('estrutura dos documentos: títulos, metadados, seções, deliberações e Presidência', () => {
  const ata = parseDocument(
    'ATA DA 92ª REUNIÃO ORDINÁRIA\nData: 11 de dezembro de 2025\nMembros Presentes (Remoto): Luan.\n\n1. ABERTURA E AGENDAMENTO\n\nTexto.\n1.1. Agendamento da Próxima Reunião\nTexto.\nDeliberação: Aprovada a prorrogação.\nData: aqui já é parágrafo comum',
  );
  assert.deepEqual(ata.map((b) => b.type), ['title', 'meta', 'meta', 'heading', 'paragraph', 'subheading', 'paragraph', 'deliberation', 'paragraph']);
  assert.equal(ata[7].label, 'Deliberação:');

  const momento = parseDocument('MOMENTO ABERTO – 906ª SESSÃO 12/12/2025\n\nRepresentante da Sociedade Civil, Fulano relata: x.\n\nPresidente: agradeceu a participação.');
  assert.deepEqual(momento.map((b) => b.type), ['title', 'paragraph', 'president']);

  assert.deepEqual(splitMarks('Luan, [Presidente não nomeado].').map((r) => r.mark), [false, true, false]);
});

test('DOCX: pacote ZIP bem formado, com XML escapado', async () => {
  const blob = buildDocx('ATA DE TESTE\n\n1. ABERTURA\n\nTexto com & < > "aspas" e [informação não identificada no áudio].\nDeliberação: Aprovado.', { title: 'Ata & teste' });
  assert.equal(blob.type, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(0, true), 0x04034b50, 'assinatura de arquivo local');
  const end = bytes.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50, 'fim do diretório central');
  assert.equal(view.getUint16(end + 10, true), 6, 'seis partes no pacote');
  const text = new TextDecoder().decode(bytes);
  assert.ok(text.includes('[Content_Types].xml') && text.includes('word/document.xml'));
  assert.ok(text.includes('Texto com &amp; &lt; &gt; &quot;aspas&quot; e '));
  assert.ok(text.includes('<w:highlight w:val="yellow"/>'), 'marcação de incerteza realçada');
  assert.ok(text.includes('<dc:title>Ata &amp; teste</dc:title>'));
});

test('erros desconhecidos viram mensagens amigáveis', () => {
  assert.equal(describeError(new AppError('NO_AUDIO')).title, 'O vídeo não possui faixa de áudio.');
  assert.equal(toAppError(new Error('WebAssembly: out of memory')).code, 'OUT_OF_MEMORY');
  assert.equal(describeError(new Error('qualquer coisa')).title, 'Não foi possível processar o vídeo. Verifique o arquivo e tente novamente.');
  const abort = new Error('x');
  abort.name = 'AbortError';
  assert.equal(toAppError(abort).code, 'CANCELED');
});
