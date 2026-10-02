// models/room.model.js

import mongoose from "mongoose";

const roomSchema = new mongoose.Schema( {
    code: {
        type: String,
        required: true,
        unique: true
    },

    participants: [
        {
            _id: false,
            userId: String,
            username: String,
            role: String,
            joinedAt: Number,
            token: String
        }
    ],

    state: {
        videoId: {
            type: String,
            default: null
        },
        currentTime: {
            type: Number,
            default: 0
        }
    }
},
{ timestamps: true }
);

export default mongoose.model("Room", roomSchema);