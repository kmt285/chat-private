const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http, { maxHttpBufferSize: 1e7 });
const fs = require("fs");
const bcrypt = require("bcryptjs");

const USERS_FILE = "./users.json";

// Database Setup
if (!fs.existsSync(USERS_FILE)) {
  fs.writeFileSync(USERS_FILE, JSON.stringify({}));
}

const getUsers = () => {
  try { return JSON.parse(fs.readFileSync(USERS_FILE)); } 
  catch (e) { return {}; }
};
const saveUser = (users) => fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));

app.get("/", (req, res) => { res.sendFile(__dirname + "/index.html"); });

let onlineUsers = {}; 

io.on("connection", (socket) => {
  console.log("Connected: " + socket.id);

  // --- REGISTER ---
  socket.on("register", async ({ username, password, displayName }) => {
    const users = getUsers();
    if (users[username]) {
      socket.emit("reg_error", "Login ID already taken!");
      return;
    }
    try {
      const hashedPassword = await bcrypt.hash(password, 10);
      users[username] = { password: hashedPassword, displayName: displayName };
      saveUser(users);
      socket.emit("reg_success", "Account created successfully! Please Login.");
    } catch (err) {
      socket.emit("reg_error", "Server error. Try again.");
    }
  });

  // --- LOGIN ---
  socket.on("login", async ({ username, password }) => {
    const users = getUsers();
    const user = users[username];

    if (!user) {
      socket.emit("login_error", "Login ID not found.");
      return;
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      socket.emit("login_error", "Incorrect password!");
      return;
    }

    // Login Success
    const displayName = user.displayName || username;
    onlineUsers[username] = { socketId: socket.id, displayName: displayName };
    socket.username = username;
    socket.displayName = displayName;

    socket.emit("login_success", { username, displayName });
    broadcastUserList();
  });

  // --- NAME CHANGE FEATURE (FIXED) ---
  socket.on("change_display_name", (newName) => {
    if (!socket.username) return; // Not logged in
    
    const users = getUsers();
    
    if (users[socket.username]) {
        // 1. Update Database File
        users[socket.username].displayName = newName;
        saveUser(users);

        // 2. Update Online List Cache
        if (onlineUsers[socket.username]) {
            onlineUsers[socket.username].displayName = newName;
        }
        socket.displayName = newName; // Update socket session name

        // 3. Notify Client & Everyone
        socket.emit("name_changed_success", newName);
        broadcastUserList(); // Update everyone's list
    }
  });

  // --- MESSAGING ---
  socket.on("private message", (data) => {
    if (!data || !data.to) return;

    const recipient = onlineUsers[data.to];

    const messageData = {
      from: socket.username,
      fromName: socket.displayName,
      toUser: data.to,
      msg: data.msg || "",
      type: data.type || 'text',
      image: data.image || null,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    if (recipient && recipient.socketId) {
      io.to(recipient.socketId).emit("private message", messageData);
      socket.emit("private message", { ...messageData, from: "Me" });
    }
  });

  socket.on("disconnect", () => {
    if (socket.username) {
      delete onlineUsers[socket.username];
      broadcastUserList();
    }
  });

  function broadcastUserList() {
    const list = Object.keys(onlineUsers).map(u => ({
      username: u,
      displayName: onlineUsers[u].displayName
    }));
    io.emit("update user list", list);
  }
});

const port = process.env.PORT || 3000;
http.listen(port, () => {
  console.log("Server running on port " + port);
});