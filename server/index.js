import { WebSocketServer, WebSocket } from "ws";
import { createUser, createMessage } from "./helper.js";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const PORT = 8080;
const wss = new WebSocketServer({ port: PORT });

const clients = new Map(); /* ws -> { id, username } */
const defaultUsernames = ["pickle", "olive", "pear", "fern", "seaweed", "mint", "lime", "sage", "jade"];

const PAGE_LENGTH = 20; // TODO: test value only, change later

wss.on("connection", (ws) => {
  console.log("New connection");

  ws.on("message", async (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return send(ws, { type: "error", message: "Invalid JSON" });
    }

    /* User join */
    if (data.type === "join") {
      const existingUser = data.user;
      let user;
      if (existingUser) {
        user = JSON.parse(existingUser);
        clients.set(ws, user);
      } else {
        const existingIds = getUserList().map(obj => obj.id);
        user = createUser(existingIds, defaultUsernames);
        clients.set(ws, user);
      }

      const userList = getUserList();

      send(ws, { type: "message_area_state", state: "loading" });
      send(ws, { type: "users", users: userList, thisUser: user });
      broadcast({ type: "user_joined", user: user, users: userList }, ws);
    }

    /* Chat message */
    if (data.type === "message") {
      const user = clients.get(ws);
      if (!user) return;

      const { data: row, error } = await supabase
          .from("messages")
          .insert([{
            sender_id: user.id,
            sender: user.username,
            content: data.text,
          }])
          .select()
          .single();
      if (error) {
        console.log("Error inserting message:", error);
        return;
      }

      const msg = createMessage(row);
      broadcast({ type: "message", message: msg });
    }

    /* Username change */
    if (data.type === "username_change") {
      const user = clients.get(ws);
      if (!user) return;

      const newUsername = data.newUsername;
      if (newUsername.length > 10 || !newUsername) return;
      user.username = newUsername;

      const userList = getUserList();

      send(ws, { type: "users", users: userList, thisUser: user });
      broadcast({ type: "users", users: userList }, ws);
    }

    /* Load messages */
    if (data.type === "load_messages") {
      const { data: rows, error } = await supabase
        .from("messages")
        .select("*")
        .order("id", { ascending: false })
        .limit(20);

      if (error) {
        console.log("Error loading messages:", error);
        send(ws, { type: "message_area_state", state: "error" });
      } else {
        send(ws, {
          type: "history",
          messages: rows.map(createMessage).reverse(),
          hasMore: rows.length === PAGE_LENGTH,
        });
        send(ws, { type: "message_area_state", state: "success" });
      }
    }

    /* Load older messages (pagination) */
    if (data.type === "load_older_messages") {
      const before = Number(data.before);
      if (!Number.isInteger(before)) {
        return send(ws, { type: "older_messages", messages: [], hasMore: false });
      }

      const { data: rows, error } = await supabase
        .from("messages")
        .select("*")
        .lt("id", before)
        .order("id", { ascending: false })
        .limit(PAGE_LENGTH);

      if (error) {
        console.log("Error loading older messages:", error);
        return send(ws, { type: "error", message: "Failed to load older messages" });
      }

      send(ws, {
        type: "older_messages",
        messages: rows.map(createMessage).reverse(),
        hasMore: rows.length === PAGE_LENGTH,
      });
    }
  });

  ws.on("close", () => {
    const user = clients.get(ws);
    clients.delete(ws);
    if (user) {
      broadcast({ type: "user_left", user, users: getUserList() });
    }
  });
});

function broadcast(payload, exclude = null) {
  /* send to everyone (allow exclusion) */
  const json = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client !== exclude && client.readyState === WebSocket.OPEN) {
      client.send(json);
    }
  }
}

function send(ws, payload) {
  /* send to thisUser */
  ws.send(JSON.stringify(payload));
}

function getUserList() {
  const seen = new Set();
  return [...clients.values()].filter((user) => {
    if (seen.has(user.id)) return false;
    seen.add(user.id);
    return true;
  });
}

console.log(`WebSocket server running on ws://localhost:${PORT}`);