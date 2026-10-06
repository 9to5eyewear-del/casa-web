import { createLoginHandler } from '../_lib/auth-handlers.js';
import { productionDeps } from '../_lib/deps.js';

export default createLoginHandler(productionDeps);
