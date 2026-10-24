/** Global options for every function. Imported first by each function module (setGlobalOptions must run before definitions). */
import { setGlobalOptions } from 'firebase-functions/v2/options';
import { REGION } from './admin';

// invoker 'public' (it applies to HTTP and callable functions only): every deploy re-applies the public
// Cloud Run invoker binding. Without it, a function whose binding failed on the project's very first deploy
// stays locked (403) forever, because later deploys don't add the binding to existing functions. The
// functions do their own auth (Firebase ID tokens, API keys, webhook secrets).
setGlobalOptions({ region: REGION, maxInstances: 10, invoker: 'public' });

export { REGION };
