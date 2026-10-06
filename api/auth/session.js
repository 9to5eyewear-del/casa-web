import { createSessionHandler } from '../_lib/auth-handlers.js';
import { productionDeps } from '../_lib/deps.js';

export default createSessionHandler(productionDeps);
