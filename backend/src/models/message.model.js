// models/message.model.js

import mongoose from "mongoose";

const messageSchema = new mongoose.Schema({
    
    roomCode: {
        type: String,
        required: true,
        index: true
    },

    userId: String,
    username: String,
    text: String,
    ts: Number
});

export default mongoose.model("Message", messageSchema);