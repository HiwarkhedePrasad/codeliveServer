const express = require("express");
const app = express();
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const server = http.createServer(app);
const { VM } = require("vm2"); // Safe execution environment
const fs = require("fs").promises;
const path = require("path");
const { exec } = require("child_process");
const util = require("util");
const execPromise = util.promisify(exec);

// Define ACTIONS constant (originally imported from ./src/assets/Actions)
const ACTIONS = {
  JOIN: "join",
  JOINED: "joined",
  FIRST_JOIN: "first-join",
  DISCONNECTED: "disconnected",
  CODE_CHANGE: "code-change",
  SYNC_CODE: "sync-code",
  FILE_CHANGE: "file-change",
  FILE_CREATED: "file-created",
  FILE_DELETED: "file-deleted",
  CURSOR_CHANGE: "cursor-change",
  EXECUTE_CODE: "execute-code",
  EXECUTION_RESULT: "execution-result",
};

// Setup temp directory for file execution
const TEMP_DIR = path.join(__dirname, "temp");

// Data structures to track users, files, and cursors
const UserSocketMap = {};
const RoomFilesMap = {};
const RoomCursorsMap = {}; // Store cursor positions by room and user

// Setup CORS and socket.io
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
  },
  transports: ["websocket", "polling"],
});

// Ensure temp directory exists
(async () => {
  try {
    await fs.mkdir(TEMP_DIR, { recursive: true });
    console.log("Temp directory created or already exists");
  } catch (err) {
    console.error("Error creating temp directory:", err);
  }
})();

// Helper functions
function getAllConnectedClient(roomId) {
  return Array.from(io.sockets.adapter.rooms.get(roomId) || []).map(
    (socketId) => {
      return {
        socketId,
        username: UserSocketMap[socketId],
      };
    }
  );
}

// Execute JavaScript code safely using VM2
async function executeJavaScript(code) {
  try {
    // Capture console output
    let output = "";
    const customConsole = {
      log: (...args) => {
        output +=
          args
            .map((arg) =>
              typeof arg === "object"
                ? JSON.stringify(arg, null, 2)
                : String(arg)
            )
            .join(" ") + "\n";
      },
      error: (...args) => {
        output +=
          "ERROR: " +
          args
            .map((arg) =>
              typeof arg === "object"
                ? JSON.stringify(arg, null, 2)
                : String(arg)
            )
            .join(" ") +
          "\n";
      },
      warn: (...args) => {
        output +=
          "WARNING: " +
          args
            .map((arg) =>
              typeof arg === "object"
                ? JSON.stringify(arg, null, 2)
                : String(arg)
            )
            .join(" ") +
          "\n";
      },
    };

    const vm = new VM({
      timeout: 5000, // 5 second timeout
      console: "redirect",
      sandbox: {
        console: customConsole,
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        setInterval: setInterval,
        clearInterval: clearInterval,
      },
    });

    // Execute the code
    const result = vm.run(code);

    // Add result to output if it's not undefined
    if (result !== undefined) {
      output += `\nReturn value: ${
        typeof result === "object" ? JSON.stringify(result, null, 2) : result
      }`;
    }

    return { output, error: null };
  } catch (error) {
    return { output: "", error: error.message };
  }
}

// Execute Python code by writing to temp file and running with Python interpreter
async function executePython(code, fileName) {
  const tempFilePath = path.join(TEMP_DIR, `${Date.now()}_${fileName}`);

  try {
    // Write code to temp file
    await fs.writeFile(tempFilePath, code);

    // Execute with Python
    const { stdout, stderr } = await execPromise(`python ${tempFilePath}`, {
      timeout: 10000, // 10 second timeout
    });

    // Clean up temp file
    await fs
      .unlink(tempFilePath)
      .catch((err) => console.error("Error deleting temp file:", err));

    return {
      output: stdout,
      error: stderr || null,
    };
  } catch (error) {
    // Clean up temp file
    await fs.unlink(tempFilePath).catch(() => {});

    return {
      output: "",
      error: error.message,
    };
  }
}

// Socket connection handler
io.on("connection", (socket) => {
  console.log(`A new connection is connected with the ID ${socket.id}`);

  // JOIN event handling
  socket.on(ACTIONS.JOIN, ({ roomId, username }) => {
    UserSocketMap[socket.id] = username;
    socket.join(roomId);
    const clients = getAllConnectedClient(roomId);

    // Initialize room data structures if they don't exist
    if (!RoomFilesMap[roomId]) {
      RoomFilesMap[roomId] = [];
    }
    if (!RoomCursorsMap[roomId]) {
      RoomCursorsMap[roomId] = {};
    }

    // Check if this is the first client to join the room
    if (clients.length === 1) {
      io.to(socket.id).emit(ACTIONS.FIRST_JOIN, {
        clients,
        files: RoomFilesMap[roomId],
      });
    } else {
      // Send existing clients, files, and cursors to the new joiner
      io.to(socket.id).emit(ACTIONS.JOINED, {
        clients,
        username,
        socketId: socket.id,
        files: RoomFilesMap[roomId],
        cursors: RoomCursorsMap[roomId],
      });
    }

    // Notify other clients about the new joiner
    socket.to(roomId).emit(ACTIONS.JOINED, {
      clients,
      username,
      socketId: socket.id,
    });
  });

  // Code execution handler
  socket.on(
    ACTIONS.EXECUTE_CODE,
    async ({ roomId, fileId, code, fileName, username }) => {
      console.log(`Executing code for ${fileName} from ${username}`);

      try {
        // Determine execution method based on file extension
        const extension = path.extname(fileName).toLowerCase();
        let result = { output: "", error: null };

        switch (extension) {
          case ".js":
            result = await executeJavaScript(code);
            break;
          case ".py":
            result = await executePython(code, fileName);
            break;
          case ".html":
            result = {
              output: "HTML files can't be executed directly in terminal.",
            };
            break;
          // Add more language handlers as needed
          default:
            result = {
              output: `Execution for ${extension} files is not supported yet.`,
            };
        }

        // Send execution result back to all clients in the room
        io.to(roomId).emit(ACTIONS.EXECUTION_RESULT, {
          result,
          username,
        });
      } catch (error) {
        console.error("Error executing code:", error);

        // Send error back to clients
        io.to(roomId).emit(ACTIONS.EXECUTION_RESULT, {
          result: {
            output: "",
            error: `Execution error: ${error.message || "Unknown error"}`,
          },
          username,
        });
      }
    }
  );

  // Handle file changes
  socket.on(
    ACTIONS.FILE_CHANGE,
    ({ roomId, fileId, content, cursorPosition, socketId }) => {
      // Update file content in server's memory
      if (RoomFilesMap[roomId]) {
        const fileIndex = RoomFilesMap[roomId].findIndex(
          (file) => file.id === fileId
        );
        if (fileIndex !== -1) {
          RoomFilesMap[roomId][fileIndex].content = content;
        }
      }

      // Update cursor position if provided
      if (cursorPosition && RoomCursorsMap[roomId]) {
        RoomCursorsMap[roomId][socketId || socket.id] = {
          fileId,
          position: cursorPosition,
          username: UserSocketMap[socketId || socket.id],
        };
      }

      // Broadcast the change to all clients in the room except the sender
      socket.to(roomId).emit(ACTIONS.FILE_CHANGE, {
        fileId,
        content,
        cursorPosition,
        socketId: socketId || socket.id,
      });
    }
  );

  // Handle explicit cursor position changes
  socket.on(
    ACTIONS.CURSOR_CHANGE,
    ({ roomId, fileId, position, socketId, username }) => {
      // Initialize room cursor map if it doesn't exist
      if (!RoomCursorsMap[roomId]) {
        RoomCursorsMap[roomId] = {};
      }

      // Store cursor position
      RoomCursorsMap[roomId][socketId || socket.id] = {
        fileId,
        position,
        username: username || UserSocketMap[socketId || socket.id],
      };

      // Broadcast cursor position to other clients
      socket.to(roomId).emit(ACTIONS.CURSOR_CHANGE, {
        socketId: socketId || socket.id,
        fileId,
        position,
        username: username || UserSocketMap[socketId || socket.id],
      });
    }
  );

  // Handle file creation
  socket.on(ACTIONS.FILE_CREATED, ({ roomId, file }) => {
    // Add new file to server's memory
    if (RoomFilesMap[roomId]) {
      RoomFilesMap[roomId].push(file);
    } else {
      RoomFilesMap[roomId] = [file];
    }

    // Broadcast the new file to all clients in the room except the sender
    socket.to(roomId).emit(ACTIONS.FILE_CREATED, { file });
  });

  // Handle file deletion
  socket.on(ACTIONS.FILE_DELETED, ({ roomId, fileId }) => {
    // Remove file from server's memory
    if (RoomFilesMap[roomId]) {
      RoomFilesMap[roomId] = RoomFilesMap[roomId].filter(
        (file) => file.id !== fileId
      );
    }

    // Broadcast the deletion to all clients in the room
    io.to(roomId).emit(ACTIONS.FILE_DELETED, { fileId });
  });

  // Legacy code synchronization (can be kept for backward compatibility)
  socket.on(ACTIONS.CODE_CHANGE, ({ roomId, code }) => {
    socket.to(roomId).emit(ACTIONS.CODE_CHANGE, { code });
  });

  // Handle disconnection
  socket.on("disconnecting", () => {
    const rooms = [...socket.rooms];
    rooms.forEach((roomId) => {
      socket.to(roomId).emit(ACTIONS.DISCONNECTED, {
        socketId: socket.id,
        username: UserSocketMap[socket.id],
      });

      // Remove cursor data for the disconnected user
      if (RoomCursorsMap[roomId]) {
        delete RoomCursorsMap[roomId][socket.id];
      }
    });

    // Clean up user data
    delete UserSocketMap[socket.id];

    socket.leave();
  });
});

// Clean up empty rooms periodically
setInterval(() => {
  for (const roomId in RoomFilesMap) {
    // Check if room has any connected clients
    if (!io.sockets.adapter.rooms.has(roomId)) {
      console.log(`Cleaning up unused room: ${roomId}`);
      delete RoomFilesMap[roomId];
      delete RoomCursorsMap[roomId];
    }
  }
}, 3600000); // Check every hour

const PORT = process.env.PORT || 5000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server is running on port ${PORT}`);
});
