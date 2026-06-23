require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bcrypt = require('bcryptjs');
const session = require('express-session');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Middleware configurations
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

app.use(session({
    secret: 'chat_secret_key_123',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 1 day session expiry
}));

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('MongoDB connected successfully!'))
    .catch(err => console.error('Database connection error:', err));

// Database Schemas and Models
const userSchema = new mongoose.Schema({
    username: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true }
});

const messageSchema = new mongoose.Schema({
    senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    receiverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    message: { type: String, required: true },
    timestamp: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);

// In-memory map to store online users and their corresponding socket IDs
const onlineUsers = new Map();

// Authentication Routing Logic
app.get('/', (req, res) => {
    if (!req.session.userId) {
        return res.redirect('/login.html');
    }
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Authentication API: Register new accounts
app.post('/api/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(400).json({ error: 'Email already registered' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ username, email, password: hashedPassword });
        await newUser.save();

        req.session.userId = newUser._id;
        req.session.username = newUser.username;
        res.status(201).json({ message: 'Registration successful' });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Authentication API: Login existing accounts
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(400).json({ error: 'Invalid email or password' });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ error: 'Invalid email or password' });
        }

        req.session.userId = user._id;
        req.session.username = user.username;
        res.json({ message: 'Login successful' });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Session API: Get current logged-in user profile
app.get('/api/current-user', (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    res.json({ _id: req.session.userId, username: req.session.username });
});

// Users API: Fetch all available contacts excluding current session user
app.get('/api/users', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const users = await User.find({ _id: { $ne: req.session.userId } }).select('username _id');
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Messaging API: Load conversation log between two users
app.get('/api/messages/:receiverId', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const currentUserId = req.session.userId;
        const targetUserId = req.params.receiverId;

        const chatHistory = await Message.find({
            $or: [
                { senderId: currentUserId, receiverId: targetUserId },
                { senderId: targetUserId, receiverId: currentUserId }
            ]
        }).sort({ timestamp: 1 });

        res.json(chatHistory);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Session API: Terminate account login session
app.post('/api/logout', (req, res) => {
    req.session.destroy(() => {
        res.json({ message: 'Logged out successfully' });
    });
});

// Real-time WebSocket Socket.io implementation
io.on('connection', (socket) => {
    // Map custom userId to active socket session ID
    socket.on('register-user', (userId) => {
        socket.userId = userId;
        onlineUsers.set(userId, socket.id);
    });

    // Handle incoming private instant messaging packet transmission
    socket.on('send-private-message', async (data) => {
        const { receiverId, message } = data;
        const senderId = socket.userId;

        if (!senderId || !receiverId || !message) return;

        try {
            // Save communication logs permanently inside database
            const newMessage = new Message({ senderId, receiverId, message });
            await newMessage.save();

            // Push message payload live to target socket stream if client is online
            const receiverSocketId = onlineUsers.get(receiverId);
            if (receiverSocketId) {
                io.to(receiverSocketId).emit('receive-private-message', {
                    senderId,
                    message
                });
            }
        } catch (err) {
            console.error('Error handling live transmission message:', err);
        }
    });

    // Listen for typing events and broadcast to the specific receiver
    socket.on('typing', (data) => {
        const receiverSocketId = onlineUsers.get(data.receiverId);
        if (receiverSocketId) {
            io.to(receiverSocketId).emit('display-typing', { senderId: data.senderId });
        }
    });

    // Listen for stop-typing events and broadcast to the specific receiver
    socket.on('stop-typing', (data) => {
        const receiverSocketId = onlineUsers.get(data.receiverId);
        if (receiverSocketId) {
            io.to(receiverSocketId).emit('hide-typing', { senderId: data.senderId });
        }
    });

    // Remove socket mapping trace profile cleanups on client connection termination
    socket.on('disconnect', () => {
        if (socket.userId) {
            onlineUsers.delete(socket.userId);
        }
    });
});

// Spin up runtime networking listener engine
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`Backend chat server is running on port ${PORT}`);
});