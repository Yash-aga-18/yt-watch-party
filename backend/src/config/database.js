//config/database.js

import mongoose from "mongoose";
import dns from "node:dns";

dns.setServers(["8.8.8.8", "1.1.1.1"]);

export function isDbReady() {
  return mongoose.connection.readyState === 1;
}

const connectDB = async () => {

  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("DB Connected successfully");
  } 
  
  catch (error) {
    console.error( "DB connection failed - continuing in memory only:",error.message );
  }
  
};

export default connectDB;
