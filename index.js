const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http, { maxHttpBufferSize: 1e7 }); 
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

// --- DATABASE CONNECTION SETUP ---
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/chat-app";
const port = process.env.PORT || 3000;

mongoose.set('strictQuery', false);

console.log("⏳ Connecting to MongoDB...");

mongoose.connect(MONGO_URI)
  .then(() => {
    console.log("✅ Connected to MongoDB Successfully!");
    http.listen(port, () => {
      console.log("🚀 Server running on port " + port);
    });
  })
  .catch(err => {
    console.error("❌ MongoDB Connection Error:", err);
  });

// --- USER SCHEMA ---
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  displayName: String,
  friends: [String]
});

const User = mongoose.model("User", userSchema);

app.get("/", (req, res) => { res.sendFile(__dirname + "/index.html"); });

let onlineUsers = {}; 
let loginAttempts = {}; 

io.on("connection", (socket) => {
  console.log("Connected: " + socket.id);

  // --- REGISTER ---
  socket.on("register", async ({ username, password, displayName }) => {
    if(!username || !password || !displayName) return;

    const usernameRegex = /^[a-z0-9]+$/;
    if (!usernameRegex.test(username)) {
        socket.emit("reg_error", "Login ID must be lowercase letters and numbers only.");
        return;
    }

    try {
      const existingUser = await User.findOne({ username });
      if (existingUser) {
        socket.emit("reg_error", "Login ID already taken!");
        return;
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      const newUser = new User({
        username,
        password: hashedPassword,
        displayName,
        friends: []
      });
      
      await newUser.save();
      socket.emit("reg_success", "Account created successfully! Please Login.");
    } catch (err) {
      console.error("Register Error:", err);
      socket.emit("reg_error", "Server error. Try again.");
    }
  });

  // --- LOGIN ---
  socket.on("login", async ({ username, password }) => {
    const now = Date.now();

    // Lock Logic
    if (loginAttempts[username]) {
        const attempt = loginAttempts[username];
        if (attempt.lockUntil && attempt.lockUntil > now) {
            const secondsLeft = Math.ceil((attempt.lockUntil - now) / 1000);
            socket.emit("login_error", `Too many attempts! Please wait ${secondsLeft} seconds.`);
            return;
        }
        if (attempt.lockUntil && attempt.lockUntil <= now) {
            delete loginAttempts[username];
        }
    }

    try {
      const user = await User.findOne({ username });
      if (!user) {
        socket.emit("login_error", "Login ID not found.");
        return;
      }

      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) {
        if (!loginAttempts[username]) {
            loginAttempts[username] = { count: 0, lockUntil: null };
        }
        loginAttempts[username].count++;
        
        if (loginAttempts[username].count >= 5) {
            loginAttempts[username].lockUntil = Date.now() + 60000;
            socket.emit("login_error", "Too many attempts! Please wait 60 seconds.");
        } else {
            const left = 5 - loginAttempts[username].count;
            socket.emit("login_error", `Incorrect password! (${left} attempts left)`);
        }
        return;
      }

      // Login Success
      if (loginAttempts[username]) delete loginAttempts[username];

      onlineUsers[username] = { socketId: socket.id, displayName: user.displayName };
      socket.username = username;
      socket.displayName = user.displayName;

      const friendDetails = await User.find({ username: { $in: user.friends } });
      const friendsData = friendDetails.map(f => ({
          username: f.username,
          displayName: f.displayName
      }));

      socket.emit("login_success", { username, displayName: user.displayName, friends: friendsData });
      broadcastUserList();

    } catch (err) {
      console.error("Login Error:", err);
      socket.emit("login_error", "Login failed due to server error.");
    }
  });

  // --- SEARCH USER ---
  socket.on("search_user", async (queryId) => {
    try {
      const user = await User.findOne({ username: queryId });
      if(user) {
           socket.emit("search_result", { 
               found: true, 
               username: user.username, 
               displayName: user.displayName 
           });
      } else {
           socket.emit("search_result", { found: false });
      }
    } catch(e) { 
        socket.emit("search_result", { found: false }); 
    }
  });

  // --- ADD FRIEND ---
  socket.on("add_friend", async (targetId) => {
    if(!socket.username || targetId === socket.username) return;

    try {
      const targetUser = await User.findOne({ username: targetId });
      if(!targetUser) return;

      const me = await User.findOne({ username: socket.username });
      if(!me.friends.includes(targetId)) {
          me.friends.push(targetId);
          await me.save();

          socket.emit("friend_added", { 
              username: targetId, 
              displayName: targetUser.displayName 
          });
          broadcastUserList(); 
      }
    } catch(e) { console.error(e); }
  });

  // --- REMOVE FRIEND ---
  socket.on("remove_friend", async (targetId) => {
    if(!socket.username) return;
    try {
      await User.updateOne(
        { username: socket.username }, 
        { $pull: { friends: targetId } }
      );
      socket.emit("friend_removed", targetId);
      broadcastUserList();
    } catch(e) { console.error(e); }
  });

  // --- CHANGE NAME ---
  socket.on("change_display_name", async (newName) => {
    if (!socket.username || !newName.trim()) return;
    try {
      await User.updateOne({ username: socket.username }, { displayName: newName });
      
      if (onlineUsers[socket.username]) onlineUsers[socket.username].displayName = newName;
      socket.displayName = newName;
      socket.emit("name_changed_success", newName);
      broadcastUserList();
    } catch(e) { console.error(e); }
  });

  // --- MESSAGING ---
  socket.on("typing", (data) => {
      if(!data.to) return;
      const recipient = onlineUsers[data.to];
      if(recipient) io.to(recipient.socketId).emit("display_typing", { from: socket.username });
  });

  socket.on("stop_typing", (data) => {
      if(!data.to) return;
      const recipient = onlineUsers[data.to];
      if(recipient) io.to(recipient.socketId).emit("hide_typing", { from: socket.username });
  });

  socket.on("private message", (data) => {
    if (!data || !data.to) return;
    if ((!data.msg || !data.msg.trim()) && !data.image) return;

    const recipient = onlineUsers[data.to];
    const messageData = {
      from: socket.username,
      fromName: socket.displayName,
      toUser: data.to,
      msg: data.msg || "",
      type: data.type || 'text',
      image: data.image || null,
      replyTo: data.replyTo || null,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    if (recipient && recipient.socketId) {
      io.to(recipient.socketId).emit("private message", messageData);
      socket.emit("private message", { ...messageData, from: "Me" });
    } else {
        socket.emit("msg_failed", { to: data.to, msg: "User is offline. Message not sent." });
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
