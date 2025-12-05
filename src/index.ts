require("dotenv").config();

const express = require("express") as typeof import("express");
const http = require("http") as typeof import("http");
const cors = require("cors") as typeof import("cors");
const { Server } = require("socket.io") as typeof import("socket.io");
const { ExpressPeerServer } = require("peer") as typeof import("peer");

type User = { uid: string; name: string; peerId: string };

type VoiceJoinAck =
  | { ok: true; peers: User[] }
  | { ok: false; error?: "BAD_REQUEST" };

function normRoomId(id: unknown) {
  return String(id || "").trim().toUpperCase();
}

const app = express();
const server = http.createServer(app);

const PORT = Number(process.env.PORT || 4010);

const rawOrigins = process.env.CLIENT_ORIGIN || "http://localhost:5173,http://127.0.0.1:5173";
const allowedOrigins = rawOrigins
  .split(",")
  .map((s: string) => s.trim())
  .filter(Boolean);

function isAllowedOrigin(origin?: string) {
  if (!origin) return true; // Postman/curl
  if (allowedOrigins.includes("*")) return true;
  if (allowedOrigins.includes(origin)) return true;

  if (origin.startsWith("http://localhost:")) return true;
  if (origin.startsWith("http://127.0.0.1:")) return true;

  return false;
}

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

app.get("/health", (_req: import("express").Request, res: import("express").Response) => {
  res.json({ ok: true, service: "voice-server" });
});

// Para que el root no muestre "Cannot GET /" (no afecta, pero se ve mejor)
app.get("/", (_req: import("express").Request, res: import("express").Response) => {
  res.status(200).send("voice-server up");
});

// PeerJS server (WebRTC signaling)
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

const rooms = new Map<string, Map<string, User>>(); // roomId -> uid -> user

io.on("connection", (socket: any) => {
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
