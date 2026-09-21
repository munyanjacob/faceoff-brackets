/**
 * Services layer — the only place in the app that talks to the backend.
 * Components and routes import from here, never from ./transport.
 */
export { authService } from "./authService";
export { bracketService } from "./bracketService";
export { votingService } from "./votingService";
export { resultsService } from "./resultsService";
export { discoveryService } from "./discoveryService";
export { ServiceError, GENERIC_ERROR_MESSAGE, toServiceError } from "./serviceError";
export { usingLiveBackend } from "./transport";
export type * from "./types";
