/**
 * voice-server
 *
 * Small signaling server combining PeerJS (WebRTC signaling) and Socket.IO
 * (room membership / peer list) used by the ChatTeam client. This file is
 * intentionally small and documents the public behaviors and helper functions.
 */

require("dotenv").config();

const express = require("express") as typeof import("express");
const http = require("http") as typeof import("http");
const cors = require("cors") as typeof import("cors");
const { Server } = require("socket.io") as typeof import("socket.io");
const { ExpressPeerServer } = require("peer") as typeof import("peer");

/**
 * Represents a connected user in a voice room.
 *
 * @typedef {Object} User
 * @property {string} uid - The application user id.
 * @property {string} name - Display name for the user.
 * @property {string} peerId - PeerJS peer identifier for WebRTC connections.
 */
type User = { uid: string; name: string; peerId: string };

/**
 * Acknowledge type returned to a client when attempting to join a voice room.
 *
 * - ok: true -> peers array of current room users
 * - ok: false -> optional error code
 */
type VoiceJoinAck =
  | { ok: true; peers: User[] }
  | { ok: false; error?: "BAD_REQUEST" };

/**
 * Normalize a room id value to a canonical uppercase trimmed string.
 *
 * @param {unknown} id - Incoming room id (may be any type).
 * @returns {string} Normalized room id (uppercase, trimmed). Empty string if input invalid.
 */
function normRoomId(id: unknown) {
  return String(id || "").trim().toUpperCase();
}

const app = express();
const server = http.createServer(app);

const PORT = Number(process.env.PORT || 4010);

/**
 * Read allowed origins from environment variable CLIENT_ORIGIN.
 * Default includes common local dev hosts.
 */
const rawOrigins = process.env.CLIENT_ORIGIN || "http://localhost:5173,http://127.0.0.1:5173,https://voice-server-et20.onrender.com";
const allowedOrigins = rawOrigins
  .split(",")
  .map((s: string) => s.trim())
  .filter(Boolean);

/**
 * Check whether a given origin is allowed to access the server.
 *
 * The function permits:
 * - undefined origins (tools like curl/postman)
 * - explicit origins listed in CLIENT_ORIGIN
 * - localhost or 127.0.0.1 with any port
 *
 * @param {string|undefined} origin - Origin header value from the request.
 * @returns {boolean} True if origin is allowed.
 */
function isAllowedOrigin(origin?: string) {
  if (!origin) return true; // Postman/curl
  if (allowedOrigins.includes("*")) return true;
  if (allowedOrigins.includes(origin)) return true;

  if (origin.startsWith("http://localhost:")) return true;
  if (origin.startsWith("http://127.0.0.1:")) return true;

  return false;
}

// Middleware: CORS and JSON parsing
app.use(
  cors({
    origin: (origin: string | undefined, cb: (err: Error | null, ok?: boolean) => void) => {
      if (isAllowedOrigin(origin)) cb(null, true);
      else cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);
app.use(express.json());

/**
 * Health check endpoint.
 *
 * @param {import("express").Request} _req
 * @param {import("express").Response} res
 */
app.get("/health", (_req: import("express").Request, res: import("express").Response) => {
  res.json({ ok: true, service: "voice-server" });
});

/**
 * Root endpoint — returns a small friendly message so the server root doesn't show
 * "Cannot GET /".
 *
 * @param {import("express").Request} _req
 * @param {import("express").Response} res
 */
app.get("/", (_req: import("express").Request, res: import("express").Response) => {
  res.status(200).send("voice-server up");
});

// PeerJS server (WebRTC signaling)
// ExpressPeerServer returns an express-compatible handler used at /peerjs
const peerServer = ExpressPeerServer(server, { path: "/peerjs" });
app.use("/peerjs", peerServer);

// Socket.IO (room membership / peer list)
const io = new Server(server, {
  cors: {
    origin: (origin: string | undefined, cb: (err: Error | null, ok?: boolean) => void) => {
      if (isAllowedOrigin(origin)) cb(null, true);
      else cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  },
});

/**
 * rooms map structure:
 * Map<roomId, Map<uid, User>>
 *
 * It stores the current membership lists in memory.
 */
const rooms = new Map<string, Map<string, User>>(); // roomId -> uid -> user

io.on("connection", (socket: any) => {
  /**
   * Handle "voice:join" event from a client that wants to join a room.
   *
   * Expects payload: { roomId, uid, name, peerId } and an optional ack callback.
   * Validates required fields, updates in-memory membership, joins socket.io room,
   * and notifies other members that a user joined.
   */
  socket.on(
    "voice:join",
    (
      payload: { roomId: string; uid: string; name: string; peerId: string },
      ack?: (res: VoiceJoinAck) => void
    ) => {
      const rid = normRoomId(payload?.roomId);
      const uid = String(payload?.uid || "").trim();
      const name = String(payload?.name || "").trim() || "Guest";
      const peerId = String(payload?.peerId || "").trim();

      if (!rid || !uid || !peerId) return ack?.({ ok: false, error: "BAD_REQUEST" });

      const map = rooms.get(rid) ?? new Map<string, User>();
      map.set(uid, { uid, name, peerId });
      rooms.set(rid, map);

      socket.join(rid);
      socket.data.rid = rid;
      socket.data.uid = uid;

      const peers = Array.from(map.values());
      ack?.({ ok: true, peers });

      socket.to(rid).emit("voice:user-joined", { uid, name, peerId });
    }
  );

  /**
   * Handle explicit "voice:leave" event from client to leave a room.
   *
   * Removes the user from the room map and notifies the rest.
   */
  socket.on("voice:leave", (payload: { roomId: string; uid: string }) => {
    const rid = normRoomId(payload?.roomId);
    const uid = String(payload?.uid || "").trim();
    if (!rid || !uid) return;

    const map = rooms.get(rid);
    if (!map) return;

    map.delete(uid);
    if (map.size === 0) rooms.delete(rid);

    socket.to(rid).emit("voice:user-left", { uid });
    socket.leave(rid);
  });

  /**
   * Handle socket disconnect: cleanup user membership if socket had joined a room.
   */
  socket.on("disconnect", () => {
    const rid = socket.data?.rid as string | undefined;
    const uid = socket.data?.uid as string | undefined;
    if (!rid || !uid) return;

    const map = rooms.get(rid);
    if (!map) return;

    map.delete(uid);
    if (map.size === 0) rooms.delete(rid);

    socket.to(rid).emit("voice:user-left", { uid });
  });
});

server.listen(PORT, () => {
  console.log(`[voice-server] listening on :${PORT}`);
  console.log(`[voice-server] allowed origins: ${allowedOrigins.join(", ")}`);
});
