//config/database.js

import mongoose from "mongoose";
import dns from "node:dns";

dns.setServers(["8.8.8.8", "1.1.1.1"]);

// True only once mongoose has an open connection. Rooms are always held in memory;
// the database adds persistence across restarts and nothing else, so every caller
// checks this first and simply skips the database when it is not there.
export function isDbReady() {
  return mongoose.connection.readyState === 1;
}

const connectDB = async () => {
  if (!process.env.MONGODB_URI) {
    console.warn("MONGODB_URI is not set - rooms will be kept in memory only.");
    return;
  }

  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("DB Connected successfully");
  } catch (error) {
    // Deliberately not fatal. A missing or unreachable database costs persistence
    // across restarts, but every live feature still works, so taking the whole
    // server down here would drop working functionality for a bonus.
    console.error(
      "DB connection failed - continuing in memory only:",
      error.message
    );
  }
};

export default connectDB;
