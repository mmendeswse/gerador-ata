// Vercel Function: POST /api/transcribe (um trecho de áudio por chamada, < 4,5 MB)
import { handleApiRequest } from '../backend/router.js';

export default {
  fetch(request) {
    return handleApiRequest(request, process.env, { route: 'transcribe' });
  },
};
