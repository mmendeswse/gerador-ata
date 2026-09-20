// Vercel Function: GET /api/health
import { handleApiRequest } from '../backend/router.js';

export default {
  fetch(request) {
    return handleApiRequest(request, process.env, { route: 'health' });
  },
};
