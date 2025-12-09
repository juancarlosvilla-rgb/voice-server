/**
 * Minimal type declarations for the "peer" module (PeerJS server integration).
 *
 * This file provides a lightweight declaration so TypeScript can type-check
 * usage of ExpressPeerServer in the project. The real package is implemented
 * in JavaScript at runtime; only the shape used here is declared.
 *
 * Note: keep the declarations intentionally small — expand if you use more APIs.
 */
declare module "peer" {
  /**
   * Create a PeerJS Express middleware that mounts the PeerJS server routes.
   *
   * @param server - The Node HTTP server instance used by PeerJS (e.g. http.createServer(app)).
   * @param options - Optional configuration object passed to PeerJS Express middleware.
   * @returns An Express-compatible request handler / router to be used with app.use().
   */
  export function ExpressPeerServer(server: any, options?: any): any;
}
