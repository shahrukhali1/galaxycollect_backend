# Live Chat Backend Integration Guide (WebSocket / Socket.io)

This guide provides the necessary steps and code architecture to connect the frontend `ChatWidget` and the `AdminLiveChat` using real-time WebSockets.

## 1. Prerequisites

You will need to install `socket.io` on your backend server and `socket.io-client` on your React frontend.

**Backend (Express):**
```bash
npm install socket.io
```

**Frontend (React):**
```bash
npm install socket.io-client
```

## 2. Backend Setup (`server.js` or `index.js`)

You need to attach Socket.io to your Express HTTP server.

```javascript
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "http://localhost:5173", // Your React app URL
    methods: ["GET", "POST"]
  }
});

// A simple in-memory store for active chats (Use MongoDB in production)
const activeChats = new Map(); 

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  // 1. User connects and starts a chat
  socket.on('join_chat', (userData) => {
    // Add user to a specific room for their chat session
    socket.join(`room_${socket.id}`);
    
    // Store chat session details
    activeChats.set(socket.id, {
      userId: socket.id,
      name: userData?.name || `Guest_${socket.id.substring(0,4)}`,
      messages: []
    });

    // Notify admins about the new chat/user
    socket.broadcast.emit('active_chats_update', Array.from(activeChats.values()));
  });

  // 2. Handling Messages from User -> Admin
  socket.on('send_message_to_admin', (data) => {
    const chat = activeChats.get(socket.id);
    if(chat) {
        const message = { id: Date.now(), text: data.text, sender: 'user', time: new Date() };
        chat.messages.push(message);
        
        // Broadcast the message to all admins
        socket.broadcast.emit('receive_message_from_user', {
            userId: socket.id,
            message: message
        });
    }
  });

  // 3. Handling Messages from Admin -> User
  socket.on('send_message_to_user', (data) => {
    // Admin sends message to a specific user's room
    const message = { id: Date.now(), text: data.text, sender: 'admin', time: new Date() };
    
    const chat = activeChats.get(data.userId);
    if(chat) {
        chat.messages.push(message);
    }

    io.to(`room_${data.userId}`).emit('receive_message_from_admin', message);
  });

  // 4. Disconnect
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    // Optional: Keep chat in DB, but remove from active session memory
    activeChats.delete(socket.id);
    socket.broadcast.emit('active_chats_update', Array.from(activeChats.values()));
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
```

## 3. Frontend Setup: User Chat (`ChatWidget.tsx`)

In your `ChatWidget.tsx`, initialize the socket connection when the Live Chat is opened.

```typescript
import { io } from "socket.io-client";

// ... inside your component
const [socket, setSocket] = useState(null);

useEffect(() => {
    // Connect only when live chat opens
    if (isLiveChatOpen && !socket) {
        const newSocket = io("http://localhost:5000"); // Your backend URL
        setSocket(newSocket);

        newSocket.on("connect", () => {
            newSocket.emit("join_chat", { name: "Website Visitor" });
        });

        newSocket.on("receive_message_from_admin", (message) => {
            setLiveChatMessages((prev) => [...prev, message]);
        });
    }

    return () => {
        // Cleanup on unmount or close
        if(socket && !isLiveChatOpen) {
            socket.disconnect();
            setSocket(null);
        }
    };
}, [isLiveChatOpen]);

// Sending a message
const handleLiveChatMessage = (e) => {
    e.preventDefault();
    // ... update local state
    
    // Send to backend
    if (socket) {
        socket.emit("send_message_to_admin", { text: liveChatInputValue });
    }
}
```

## 4. Frontend Setup: Admin Dashboard (`AdminLiveChat.tsx`)

In your Admin Dashboard component, connect to the socket to listen for all incoming chats.

```typescript
import { io } from "socket.io-client";

// ... inside your AdminLiveChat component
const [socket, setSocket] = useState(null);

useEffect(() => {
    const newSocket = io("http://localhost:5000");
    setSocket(newSocket);

    newSocket.on("connect", () => {
        // You might want to authenticate the admin socket here
        console.log("Admin connected to socket");
    });

    newSocket.on("active_chats_update", (activeChats) => {
        // Update your sidebar list of users
        setChats(activeChats);
    });

    newSocket.on("receive_message_from_user", (data) => {
        // Update the specific chat's message history
        // data contains: { userId, message }
    });

    return () => newSocket.disconnect();
}, []);

// Admin replying
const handleSendMessage = (e) => {
    e.preventDefault();
    // ... update local state
    
    if (socket) {
        socket.emit("send_message_to_user", { 
            userId: activeChatId, 
            text: inputValue 
        });
    }
}
```

## Next Steps for Production
1. **Database:** Instead of keeping `activeChats` in a Map in memory (which clears when the server restarts), save message threads to MongoDB.
2. **Authentication:** Ensure that only verified Admin users can connect and emit `send_message_to_user` events.
3. **History Loading:** When the admin or user connects, load their previous message history from the database via a standard REST API `GET /api/chats/:id`, then rely on WebSockets for real-time new messages.
