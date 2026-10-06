import { createPushSubscribeHandler } from '../_lib/auth-handlers.js';
import { productionDeps } from '../_lib/deps.js';

export default createPushSubscribeHandler(productionDeps);
