import { createLoginHandler, createLogoutHandler, createSessionHandler } from '../_lib/auth-handlers.js';
import { productionDeps } from '../_lib/deps.js';
import { send, query } from '../_lib/http.js';

// /api/auth/login · /api/auth/logout · /api/auth/session in one function:
// the Vercel Hobby plan deploys at most 12, and a 13th fails the deploy.
const handlers = {
  login: createLoginHandler(productionDeps),
  logout: createLogoutHandler(),
  session: createSessionHandler(productionDeps),
};

export default function handler(req, res) {
  const action = query(req).action;
  const h = Object.hasOwn(handlers, action) ? handlers[action] : null;
  return h ? h(req, res) : send(res, 404, { error: 'not_found' });
}
