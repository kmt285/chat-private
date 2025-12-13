const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http, { maxHttpBufferSize: 1e7 }); 
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const webpush = require('web-push');
const bodyParser = require('body-parser');
require('dotenv').config();

// --- CONFIGURATION ---
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/chat-app";
const port = process.env.PORT || 3000;

// *** VAPID KEYS FOR PUSH NOTIFICATIONS (REPLACE THESE!) ***
const publicVapidKey = 'YOUR_PUBLIC_KEY_HERE';
const privateVapidKey = 'YOUR_PRIVATE_KEY_HERE';

webpush.setVapidDetails('mailto:admin@example.com', publicVapidKey, privateVapidKey);

app.use(bodyParser.json());
app.use(express.static(__dirname));

mongoose.set('strictQuery', false);
mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.error("❌ DB Error:", err));

// --- SCHEMAS ---
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  displayName: String,
  friends: [String],
  lastSeen: { type: Date, default: Date.now } // NEW: Last Seen
});
const User = mongoose.model("User", userSchema);

const subSchema = new mongoose.Schema({
  username: String,
  payload: Object
});
const Subscription = mongoose.model("Subscription", subSchema);

const pendingSchema = new mongoose.Schema({
  from: String, fromName: String, toUser: String,
  msg: String, type: String, image: String, replyTo: Object,
  timestamp: String,
  createdAt: { type: Date, default: Date.now, expires: 604800 } 
});
const PendingMessage = mongoose.model("PendingMessage", pendingSchema);

const archiveSchema = new mongoose.Schema({
  from: String, fromName: String, toUser: String,
  msg: String, type: String, image: String, replyTo: Object,
  timestamp: String,
  createdAt: { type: Date, default: Date.now }
});
const ArchivedMessage = mongoose.model("ArchivedMessage", archiveSchema);

// --- ROUTES ---
app.get("/", (req, res) => { res.sendFile(__dirname + "/index.html"); });

// Push Subscription Route
app.post('/subscribe', async (req, res) => {
  const { username, subscription } = req.body;
  if(!username || !subscription) return res.status(400).json({});
  await Subscription.findOneAndUpdate({ username }, { payload: subscription }, { upsert: true, new: true });
  res.status(201).json({});
});

let onlineUsers = {}; 
let loginAttempts = {}; 

io.on("connection", (socket) => {
  // --- AUTH ---
  socket.on("register", async ({ username, password, displayName }) => {
    if(!username || !password || !displayName) return;
    const usernameRegex = /^[a-z0-9]+$/;
    if (!usernameRegex.test(username)) return socket.emit("reg_error", "User ID must be lowercase letters/numbers only.");
    try {
      if(await User.findOne({ username })) return socket.emit("reg_error", "ID Taken");
      const hashedPassword = await bcrypt.hash(password, 10);
      await new User({ username, password: hashedPassword, displayName, friends: [], lastSeen: new Date() }).save();
      socket.emit("reg_success", "Account Created!");
    } catch (e) { socket.emit("reg_error", "Server Error"); }
  });

  socket.on("login", async ({ username, password }) => {
    try {
      const user = await User.findOne({ username });
      if (!user || !(await bcrypt.compare(password, user.password))) {
        return socket.emit("login_error", "Invalid Credentials");
      }

      // Update Online Status
      onlineUsers[username] = { socketId: socket.id, displayName: user.displayName };
      socket.username = username;
      socket.displayName = user.displayName;
      
      // Update Last Seen to NOW (since they just logged in)
      await User.updateOne({ username }, { lastSeen: new Date() });

      // Fetch Friends with Last Seen Data
      const friends = await User.find({ username: { $in: user.friends } });
      const friendsData = friends.map(f => ({ 
          username: f.username, 
          displayName: f.displayName,
          lastSeen: f.lastSeen // Send Last Seen to frontend
      }));

      socket.emit("login_success", { 
          username, 
          displayName: user.displayName, 
          friends: friendsData 
      });
      broadcastUserList();

      // Pending Messages
      const pendings = await PendingMessage.find({ toUser: username });
      if (pendings.length > 0) {
        for (const msg of pendings) {
            socket.emit("private message", {
                from: msg.from, fromName: msg.fromName, toUser: msg.toUser,
                msg: msg.msg, type: msg.type, image: msg.image, 
                replyTo: msg.replyTo, timestamp: msg.timestamp
            });
            await PendingMessage.deleteOne({ _id: msg._id }); 
        }
      }
    } catch (e) { console.error(e); }
  });

  // --- MESSAGING ---
  socket.on("private message", async (data) => {
    if (!data.to || ((!data.msg || !data.msg.trim()) && !data.image)) return;

    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const msgData = {
        from: socket.username, fromName: socket.displayName, toUser: data.to,
        msg: data.msg || "", type: data.type || 'text', image: data.image || null,
        replyTo: data.replyTo || null, timestamp
    };

    try {
        await new ArchivedMessage(msgData).save(); // Archive
        socket.emit("private message", { ...msgData, from: "Me" }); // Echo to self

        const recipient = onlineUsers[data.to];
        if (recipient) {
            io.to(recipient.socketId).emit("private message", msgData);
        } else {
            // Offline: Save Pending & Send Push Notification
            await new PendingMessage(msgData).save();
            
            // SEND PUSH NOTIFICATION
            const sub = await Subscription.findOne({ username: data.to });
            if(sub && sub.payload) {
                const payload = JSON.stringify({
                    title: `${socket.displayName}`,
                    body: data.type === 'image' ? "Sent a photo 📷" : data.msg,
                    icon: "icon-192.png"
                });
                webpush.sendNotification(sub.payload, payload).catch(e => console.error("Push Error", e));
            }
        }
    } catch (err) { console.error(err); }
  });

  // --- HELPERS ---
  socket.on("search_user", async (q) => {
      const u = await User.findOne({ username: q });
      socket.emit("search_result", u ? { found:true, username:u.username, displayName:u.displayName } : { found:false });
  });
  
  socket.on("add_friend", async (tid) => {
      await User.updateOne({ username: socket.username }, { $addToSet: { friends: tid } });
      const f = await User.findOne({ username: tid });
      socket.emit("friend_added", { username: f.username, displayName: f.displayName, lastSeen: f.lastSeen });
  });
  
  socket.on("remove_friend", async (tid) => {
      await User.updateOne({ username: socket.username }, { $pull: { friends: tid } });
      socket.emit("friend_removed", tid);
  });
  
  socket.on("change_display_name", async (n) => {
      await User.updateOne({ username: socket.username }, { displayName: n });
      if(onlineUsers[socket.username]) onlineUsers[socket.username].displayName = n;
      socket.displayName = n;
      socket.emit("name_changed_success", n);
      broadcastUserList();
  });

  socket.on("disconnect", async () => {
    if (socket.username) { 
        // Update Last Seen on Disconnect
        await User.updateOne({ username: socket.username }, { lastSeen: new Date() });
        delete onlineUsers[socket.username]; 
        broadcastUserList(); 
    }
  });

  function broadcastUserList() {
    io.emit("update user list", Object.keys(onlineUsers).map(u => ({ username: u, displayName: onlineUsers[u].displayName })));
  }
});
