const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http, {
  maxHttpBufferSize: 1e7 // 10MB (Lag မဖြစ်အောင် လျှော့ချထားသည်)
});

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

let users = {};

io.on("connection", (socket) => {
  console.log("New connection: " + socket.id);

  // Login
  socket.on("login", (nickname) => {
    if (!nickname) return;

    // ရှိပြီးသားနာမည်နဲ့ Socket ID အသစ်ကို ပြန်ချိတ်ပေးခြင်း
    users[nickname] = socket.id;
    socket.nickname = nickname;

    // လူတိုင်းကို စာရင်းအသစ်ပြန်ပို့
    io.emit("update user list", Object.keys(users));
    console.log(nickname + " logged in.");
  });

  // Message Handling
  socket.on("private message", (data) => {
    if (!data || !data.to) return;
    const recipientSocketId = users[data.to];

    const messageData = {
      from: socket.nickname,
      toUser: data.to,
      msg: data.msg || "",
      type: data.type || 'text',
      image: data.image || null,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    if (recipientSocketId) {
      io.to(recipientSocketId).emit("private message", messageData);

      // ကိုယ့်ဆီပြန်ပို့ (Me)
      const myCopy = { ...messageData, from: "Me" };
      socket.emit("private message", myCopy);
    }
  });

  // Disconnect
  socket.on("disconnect", () => {
    // လိုင်းကျသွားရင် ချက်ချင်းမဖျက်ဘဲ ခဏစောင့်ချင်ရင် ရပေမဲ့
    // ရိုးရှင်းအောင် လောလောဆယ် ဖျက်တဲ့စနစ်ပဲ သုံးပါမယ်
    if (socket.nickname) {
      delete users[socket.nickname];
      io.emit("update user list", Object.keys(users));
      console.log(socket.nickname + " disconnected.");
    }
  });
});

http.listen(3000, () => {
  console.log("Server is running...");
});