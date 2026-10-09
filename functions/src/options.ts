/** Global options for every function. Imported first by each function module (setGlobalOptions must run before definitions). */
import { setGlobalOptions } from 'firebase-functions/v2/options';
import { REGION } from './admin';

setGlobalOptions({ region: REGION, maxInstances: 10 });

export { REGION };
