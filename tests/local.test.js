/** Testes do provedor local (whisper.cpp + Ollama): partes puras. */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LOCAL_VOICE_LABEL, toJsonSchema, whisperToTranscription } from '../backend/providers/local.js';
import { transcriptionSchema } from '../backend/schemas.js';

test('toJsonSchema: converte tipos maiúsculos e remove propertyOrdering', () => {
  const convertido = toJsonSchema(transcriptionSchema);
  assert.equal(convertido.type, 'object');
  assert.equal(convertido.propertyOrdering, undefined);
  assert.equal(convertido.properties.segmentos.type, 'array');
  assert.equal(convertido.properties.segmentos.items.type, 'object');
  assert.equal(convertido.properties.segmentos.items.properties.inicio.type, 'string');
  assert.deepEqual(convertido.properties.qualidade_audio.enum, ['boa', 'regular', 'ruim', 'sem_fala']);
  assert.deepEqual(convertido.required, transcriptionSchema.required);
  // O esquema original não é alterado.
  assert.equal(transcriptionSchema.type, 'OBJECT');
});

const fala = (fromMs, toMs, text) => ({ offsets: { from: fromMs, to: toMs }, text });

test('whisperToTranscription: reúne frases próximas e separa nas pausas longas', () => {
  const saida = whisperToTranscription({
    transcription: [
      fala(0, 2000, ' Bom dia a todos.'),
      fala(2500, 5000, 'Declaro aberta a reunião.'),
      fala(12000, 15000, 'Passamos à ordem do dia.'), // pausa de 7 s: novo segmento
    ],
  });
  assert.equal(saida.segmentos.length, 2);
  assert.equal(saida.segmentos[0].inicio, '00:00');
  assert.equal(saida.segmentos[0].texto, 'Bom dia a todos. Declaro aberta a reunião.');
  assert.equal(saida.segmentos[1].inicio, '00:12');
  assert.equal(saida.segmentos[0].falante, LOCAL_VOICE_LABEL);
  assert.equal(saida.falantes.length, 1);
  assert.equal(saida.falantes[0].rotulo, LOCAL_VOICE_LABEL);
  assert.equal(saida.qualidade_audio, 'regular');
});

test('whisperToTranscription: descarta marcações não faladas e áudio sem fala', () => {
  const comMarcacao = whisperToTranscription({
    transcription: [fala(0, 1000, ' [Música]'), fala(1000, 3000, 'Boa tarde.')],
  });
  assert.equal(comMarcacao.segmentos.length, 1);
  assert.equal(comMarcacao.segmentos[0].texto, 'Boa tarde.');

  const vazio = whisperToTranscription({ transcription: [] });
  assert.equal(vazio.segmentos.length, 0);
  assert.equal(vazio.qualidade_audio, 'sem_fala');
});

test('whisperToTranscription: limita o tamanho dos blocos reunidos', () => {
  const frase = 'Uma frase de exemplo com algumas palavras para ocupar espaço. ';
  const itens = [];
  for (let i = 0; i < 30; i += 1) itens.push(fala(i * 1000, i * 1000 + 900, frase));
  const saida = whisperToTranscription({ transcription: itens });
  assert.ok(saida.segmentos.length > 1);
  for (const segmento of saida.segmentos) assert.ok(segmento.texto.length <= 700);
});
