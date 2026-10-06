import { createRemindersHandler } from '../_lib/cron.js';
import { productionDeps } from '../_lib/deps.js';

export default createRemindersHandler(productionDeps);
