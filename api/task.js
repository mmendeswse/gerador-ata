// Vercel Function: POST /api/task (análise, redação e revisão dos documentos)
import { handleApiRequest } from '../backend/router.js';

export default {
  fetch(request) {
    return handleApiRequest(request, process.env, { route: 'task' });
  },
};
