const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http, { maxHttpBufferSize: 1e7 }); 
const fs = require("fs");
const path = require("path"); // path module ထည့်လိုက်ပါ
const bcrypt = require("bcryptjs");

// File Path ကို ပိုတိကျအောင် path.join နဲ့ သုံးပါ
const USERS_FILE = path.join(__dirname, "users.json");

// Database Setup
if (!fs.existsSync(USERS_FILE)) {
  fs.writeFileSync(USERS_FILE, JSON.stringify({}));
}

// UTF-8 encoding ထည့်ဖတ်မှ data ပိုမှန်ပါမယ်
const getUsers = () => {
  try { 
      const data = fs.readFileSync(USERS_FILE, 'utf8');
      return JSON.parse(data); 
  } 
  catch (e) { return {}; }
};

const saveUser = (users) => fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));

app.get("/", (req, res) => { res.sendFile(__dirname + "/index.html"); });

let onlineUsers = {}; 
let loginAttempts = {}; 

io.on("connection", (socket) => {
  console.log("Connected: " + socket.id);

  // --- REGISTER (FIXED) ---
  socket.on("register", async ({ username, password, displayName }) => {
    if(!username || !password || !displayName) return;

    const usernameRegex = /^[a-z0-9]+$/;
    if (!usernameRegex.test(username)) {
        socket.emit("reg_error", "Login ID must be lowercase letters and numbers only (a-z, 0-9).");
        return;
    }

    // ၁။ အရင်ဆုံး Duplicate ရှိမရှိ အကြမ်းစစ်မယ်
    let users = getUsers();
    if (users[username]) {
      socket.emit("reg_error", "Login ID already taken!");
      return;
    }

    try {
      // ၂။ Password Hash လုပ်မယ် (ဒီအဆင့်က ကြာတတ်ပါတယ်)
      const hashedPassword = await bcrypt.hash(password, 10);

      // ၃။ Hash လုပ်ပြီးမှ Data ကို 'Fresh' ဖြစ်အောင် ပြန်ဖတ်မယ် (အရေးကြီးဆုံးအချက်ပါ)
      users = getUsers(); 

      // ၄။ နောက်တစ်ခေါက် ထပ်စစ်မယ် (Race condition ကာကွယ်ရန်)
      if (users[username]) {
          socket.emit("reg_error", "Login ID already taken!");
          return;
      }

      // ၅။ ပြီးမှ Save လုပ်မယ်
      users[username] = { password: hashedPassword, displayName: displayName, friends: [] };
      saveUser(users);

      socket.emit("reg_success", "Account created successfully! Please Login.");
    } catch (err) {
      console.error(err);
      socket.emit("reg_error", "Server error. Try again.");
    }
  });

  // --- LOGIN ---
  socket.on("login", async ({ username, password }) => {
    const now = Date.now();

    // Lock Check
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

    const users = getUsers();
    const user = users[username];

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

    // Data Repair (Friend list မရှိရင် ထည့်ပေးပြီး ပြန်သိမ်း)
    if (!user.friends) {
        // Fresh read before write (Safety)
        const currentUsers = getUsers();
        if(currentUsers[username]) {
            currentUsers[username].friends = [];
            saveUser(currentUsers);
            user.friends = []; // update local variable
        }
    }

    const displayName = user.displayName || username;
    onlineUsers[username] = { socketId: socket.id, displayName: displayName };
    socket.username = username;
    socket.displayName = displayName;

    const friendsData = (user.friends || []).map(fid => ({
        username: fid,
        displayName: users[fid] ? users[fid].displayName : fid
    }));

    socket.emit("login_success", { username, displayName, friends: friendsData });
    broadcastUserList();
  });

  // --- SEARCH USER ---
  socket.on("search_user", (queryId) => {
    const users = getUsers();
    if(users[queryId]) {
         socket.emit("search_result", { 
             found: true, 
             username: queryId, 
             displayName: users[queryId].displayName 
         });
    } else {
         socket.emit("search_result", { found: false });
    }
  });

  // --- ADD FRIEND ---
  socket.on("add_friend", (targetId) => {
    if(!socket.username) return;
    // အသစ်ဖတ်မယ်
    const users = getUsers();

    if(users[targetId] && users[socket.username]) {
        const myData = users[socket.username];
        if(!myData.friends) myData.friends = [];

        if(!myData.friends.includes(targetId) && targetId !== socket.username) {
            myData.friends.push(targetId);
            saveUser(users); // Save

            socket.emit("friend_added", { 
                username: targetId, 
                displayName: users[targetId].displayName 
            });
            broadcastUserList(); 
        }
    }
  });

  // --- REMOVE FRIEND ---
  socket.on("remove_friend", (targetId) => {
    if(!socket.username) return;
    const users = getUsers();

    if(users[socket.username]) {
        const myData = users[socket.username];
        if(myData.friends && myData.friends.includes(targetId)) {
            myData.friends = myData.friends.filter(id => id !== targetId);
            saveUser(users);

            socket.emit("friend_removed", targetId);
            broadcastUserList();
        }
    }
  });

  // --- OTHER FEATURES ---
  socket.on("change_display_name", (newName) => {
    if (!socket.username || !newName.trim()) return;
    const users = getUsers();
    if (users[socket.username]) {
        users[socket.username].displayName = newName;
        saveUser(users);
        if (onlineUsers[socket.username]) onlineUsers[socket.username].displayName = newName;
        socket.displayName = newName;
        socket.emit("name_changed_success", newName);
        broadcastUserList();
    }
  });

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

const port = process.env.PORT || 3000;
http.listen(port, () => {
  console.log("Server running on port " + port);
});