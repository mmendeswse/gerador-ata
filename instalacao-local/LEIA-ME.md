# Modo 100% local — sem serviço de IA (gratuito e privado)

Neste modo o sistema roda **inteiro no seu computador**: a transcrição é feita
pelo [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (Whisper, da OpenAI,
código aberto) e a redação dos documentos pelo [Ollama](https://ollama.com)
com um modelo de linguagem aberto. **Nenhum áudio ou texto sai da máquina** e
não há cota, chave de API nem custo.

## Instalação (uma única vez)

1. Dê um **duplo clique em `instalar.cmd`** (nesta pasta) e aguarde.
   O instalador baixa ~350 MB (whisper + modelo de áudio) e ~4,9 GB (modelo de
   redação) e preenche o arquivo `.env` do projeto automaticamente.
2. Ao final, dê um duplo clique em **`iniciar-local.cmd`** (na pasta do
   projeto) e use o sistema em <http://localhost:3000>.

## O que esperar (leia antes de usar)

| Aspecto | Modo local | Modo Gemini (nuvem) |
| --- | --- | --- |
| Custo / cota | zero, ilimitado | cota gratuita limitada ou centavos por reunião |
| Privacidade | nada sai do computador | áudio e transcrição vão ao Google |
| Velocidade (3 h de reunião) | horas (depende do computador) | ~30–45 min |
| Separação de vozes | **não há** — participantes são identificados só pelo contexto (apresentações, vocativos) | sim |
| Qualidade da redação | boa, mas inferior; **revise com atenção redobrada** | melhor |

Recomendações: use em reuniões **curtas** ou quando a privacidade for
indispensável; num notebook sem placa de vídeo dedicada, deixe o computador
na tomada e evite usá-lo durante o processamento.

## Ajustes opcionais (arquivo `.env` na pasta do projeto)

- **Transcrição mais precisa (e ~3x mais lenta):** baixe o modelo
  `ggml-medium.bin` de <https://huggingface.co/ggerganov/whisper.cpp/tree/main>
  para `instalacao-local/modelos/` e aponte `WHISPER_MODEL` para ele.
- **Redação melhor (exige 16 GB+ de RAM):** `ollama pull qwen3:14b` e
  `OLLAMA_MODEL=qwen3:14b`.
- **Reuniões longas:** aumente `OLLAMA_NUM_CTX` (ex.: `32768`) — consome mais
  memória RAM.
- Para voltar ao Gemini, basta trocar `AI_PROVIDER=local` por
  `AI_PROVIDER=gemini` no `.env`.

## Limitações conhecidas do modo local

1. Sem separação de vozes: a coluna de falantes mostra uma voz única; use a
   aba *Transcrição* para corrigir/atribuir participantes manualmente.
2. Em reuniões muito longas, o modelo local pode não conseguir considerar a
   transcrição inteira de uma vez (janela de contexto) — os documentos podem
   omitir trechos do início. Prefira reuniões de até ~1 h neste modo.
3. As verificações de fidelidade em código (citações literais, números,
   formato do Momento Aberto) continuam ativas e funcionam normalmente.
