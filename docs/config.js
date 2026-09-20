/**
 * CONFIGURAÇÃO PÚBLICA DA INTERFACE
 * ---------------------------------------------------------------------------
 * Este arquivo é público (fica no GitHub Pages). NUNCA coloque aqui chave de
 * API, senha ou qualquer segredo. A chave da IA fica somente no servidor
 * (variável de ambiente GEMINI_API_KEY).
 */
window.APP_CONFIG = {
  /**
   * Endereço do servidor de processamento (backend), SEM barra no final.
   *   • GitHub Pages:  "https://seu-projeto.vercel.app"
   *   • Interface e servidor no mesmo endereço (Vercel, Cloudflare, local): deixe "".
   * Também pode ser informado pela tela, em "Configurações".
   */
  API_BASE_URL: "",

  /** Duração aproximada de cada trecho de áudio enviado para transcrição (minutos). */
  CHUNK_MINUTES: 10,

  /** Taxa do áudio MP3 mono 16 kHz enviado à IA (kbps). 40 kbps ≈ 3 MB a cada 10 minutos. */
  AUDIO_BITRATE_KBPS: 40,

  /** Tamanho máximo aceito para o arquivo de vídeo (GB). */
  MAX_FILE_SIZE_GB: 8,

  /**
   * De onde baixar o núcleo do ffmpeg.wasm (≈ 31 MB, baixado uma vez e guardado
   * no cache do navegador). A integridade dos arquivos é conferida por SHA-256.
   * Para hospedar você mesmo, copie ffmpeg-core.js e ffmpeg-core.wasm (versão 0.12.10)
   * para docs/vendor/ffmpeg-core/ e coloque "vendor/ffmpeg-core" no início da lista.
   * (Só se usar OUTRA versão do núcleo: acrescente FFMPEG_CORE_SKIP_INTEGRITY: true.)
   */
  FFMPEG_CORE_SOURCES: [
    "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd",
    "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd"
  ]
};
