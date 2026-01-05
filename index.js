// save as index.js
// npm install express ws axios fca-mafiya uuid

const fs = require('fs');
const express = require('express');
const wiegine = require('fca-mafiya');
const WebSocket = require('ws');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 20428;

// Store active tasks - Persistent storage simulation
const TASKS_FILE = 'active_tasks.json';
const COOKIES_DIR = 'cookies';

// Ensure directories exist
if (!fs.existsSync(COOKIES_DIR)) {
    fs.mkdirSync(COOKIES_DIR, { recursive: true });
}

// Load persistent tasks
function loadTasks() {
    try {
        if (fs.existsSync(TASKS_FILE)) {
            const data = fs.readFileSync(TASKS_FILE, 'utf8');
            const tasksData = JSON.parse(data);
            const tasks = new Map();

            for (let [taskId, taskData] of Object.entries(tasksData)) {
                const task = new Task(taskId, taskData.userData);
                task.config = taskData.config;
                task.messageData = taskData.messageData;
                task.stats = taskData.stats;
                task.logs = taskData.logs || [];
                task.config.running = true; // Auto-restart
                tasks.set(taskId, task);

                console.log(`🔥 Reloaded persistent task: ${taskId}`);

                // Auto-restart the task
                setTimeout(() => {
                    if (task.config.running) {
                        task.start();
                    }
                }, 5000);
            }

            return tasks;
        }
    } catch (error) {
        console.error('Error loading tasks:', error);
    }
    return new Map();
}

// Save tasks persistently
function saveTasks() {
    try {
        const tasksData = {};
        for (let [taskId, task] of activeTasks.entries()) {
            if (task.config.running) { // Only save running tasks
                tasksData[taskId] = {
                    userData: task.userData,
                    config: { ...task.config, api: null }, // Remove api reference
                    messageData: task.messageData,
                    stats: task.stats,
                    logs: task.logs.slice(0, 50) // Keep recent logs only
                };
            }
        }
        fs.writeFileSync(TASKS_FILE, JSON.stringify(tasksData, null, 2));
    } catch (error) {
        console.error('Error saving tasks:', error);
    }
}

// Auto-save tasks every 30 seconds
setInterval(saveTasks, 30000);

// Auto-restart mechanism
function setupAutoRestart() {
    // Check every minute for stuck tasks
    setInterval(() => {
        for (let [taskId, task] of activeTasks.entries()) {
            if (task.config.running && !task.healthCheck()) {
                console.log(`🔥 Auto-restarting stuck task: ${taskId}`);
                task.restart();
            }
        }
    }, 60000);
}

let activeTasks = loadTasks();

// Enhanced Task management class with auto-recovery
class Task {
    constructor(taskId, userData) {
        this.taskId = taskId;
        this.userData = userData;
        this.config = {
            prefix: '',
            delay: userData.delay || 5,
            running: false,
            api: null,
            repeat: true,
            lastActivity: Date.now(),
            restartCount: 0,
            maxRestarts: 1000 // Unlimited restarts essentially
        };
        this.messageData = {
            threadID: userData.threadID,
            messages: [],
            currentIndex: 0,
            loopCount: 0
        };
        this.stats = {
            sent: 0,
            failed: 0,
            activeCookies: 0,
            loops: 0,
            restarts: 0,
            lastSuccess: null
        };
        this.logs = [];
        this.retryCount = 0;
        this.maxRetries = 50;
        this.initializeMessages(userData.messageContent, userData.hatersName, userData.lastHereName);
    }

    initializeMessages(messageContent, hatersName, lastHereName) {
        this.messageData.messages = messageContent
            .split('\n')
            .map(line => line.replace(/\r/g, '').trim())
            .filter(line => line.length > 0)
            .map(message => `${hatersName} ${message} ${lastHereName}`);

        this.addLog(`Loaded ${this.messageData.messages.length} formatted messages`);
    }

    addLog(message, messageType = 'info') {
        const logEntry = {
            time: new Date().toLocaleTimeString('en-IN'),
            message: message,
            type: messageType
        };
        this.logs.unshift(logEntry);
        if (this.logs.length > 100) {
            this.logs = this.logs.slice(0, 100);
        }

        this.config.lastActivity = Date.now();
        broadcastToTask(this.taskId, {
            type: 'log',
            message: message,
            messageType: messageType
        });
    }

    healthCheck() {
        // If no activity for 5 minutes, consider stuck
        return Date.now() - this.config.lastActivity < 300000;
    }

    async start() {
        if (this.config.running) {
            this.addLog('Task is already running', 'info');
            return true;
        }

        this.config.running = true;
        this.retryCount = 0;

        try {
            const cookiePath = `${COOKIES_DIR}/cookie_${this.taskId}.txt`;
            fs.writeFileSync(cookiePath, this.userData.cookieContent);
            this.addLog('Cookie content saved', 'success');
        } catch (err) {
            this.addLog(`Failed to save cookie: ${err.message}`, 'error');
            this.config.running = false;
            return false;
        }

        if (this.messageData.messages.length === 0) {
            this.addLog('No messages found in the file', 'error');
            this.config.running = false;
            return false;
        }

        this.addLog(`Starting task with ${this.messageData.messages.length} messages`);

        return this.initializeBot();
    }

    initializeBot() {
        return new Promise((resolve) => {
            wiegine.login(this.userData.cookieContent, { 
                logLevel: "silent",
                forceLogin: true,
                selfListen: false
            }, (err, api) => {
                if (err || !api) {
                    this.addLog(`Login failed: ${err ? err.message : 'Unknown error'}`, 'error');

                    // Auto-retry login
                    if (this.retryCount < this.maxRetries) {
                        this.retryCount++;
                        this.addLog(`Auto-retry login attempt ${this.retryCount}/${this.maxRetries} in 30 seconds...`, 'info');

                        setTimeout(() => {
                            this.initializeBot();
                        }, 30000);
                    } else {
                        this.addLog('Max login retries reached. Task paused.', 'error');
                        this.config.running = false;
                    }

                    resolve(false);
                    return;
                }

                this.config.api = api;
                this.stats.activeCookies = 1;
                this.retryCount = 0;
                this.addLog('Logged in successfully', 'success');

                // Enhanced error handling for API
                this.setupApiErrorHandling(api);

                this.getGroupInfo(api, this.messageData.threadID);

                this.sendNextMessage(api);
                resolve(true);
            });
        });
    }

    setupApiErrorHandling(api) {
        // Handle various API errors gracefully
        if (api && typeof api.listen === 'function') {
            try {
                api.listen((err, event) => {
                    if (err) {
                        // Silent error handling - no user disruption
                        console.log(`🔥 Silent API error handled for task ${this.taskId}`);
                    }
                });
            } catch (e) {
                // Silent catch - no disruption
            }
        }
    }

    getGroupInfo(api, threadID) {
        try {
            if (api && typeof api.getThreadInfo === 'function') {
                api.getThreadInfo(threadID, (err, info) => {
                    if (!err && info) {
                        this.addLog(`Target: ${info.name || 'Unknown'} (ID: ${threadID})`, 'info');
                    }
                });
            }
        } catch (e) {
            // Silent error - group info not critical
        }
    }

    sendNextMessage(api) {
        if (!this.config.running || !api) {
            return;
        }

        // Message loop management
        if (this.messageData.currentIndex >= this.messageData.messages.length) {
            this.messageData.loopCount++;
            this.stats.loops = this.messageData.loopCount;
            this.addLog(`Loop #${this.messageData.loopCount} completed. Restarting.`, 'info');
            this.messageData.currentIndex = 0;
        }

        const message = this.messageData.messages[this.messageData.currentIndex];
        const currentIndex = this.messageData.currentIndex;
        const totalMessages = this.messageData.messages.length;

        // Enhanced send with multiple fallbacks
        this.sendMessageWithRetry(api, message, currentIndex, totalMessages);
    }

    sendMessageWithRetry(api, message, currentIndex, totalMessages, retryAttempt = 0) {
        if (!this.config.running) return;

        const maxSendRetries = 10;

        try {
            api.sendMessage(message, this.messageData.threadID, (err) => {
                const timestamp = new Date().toLocaleTimeString('en-IN');

                if (err) {
                    this.stats.failed++;

                    if (retryAttempt < maxSendRetries) {
                        this.addLog(`🔄 RETRY ${retryAttempt + 1}/${maxSendRetries} | Message ${currentIndex + 1}/${totalMessages}`, 'info');

                        setTimeout(() => {
                            this.sendMessageWithRetry(api, message, currentIndex, totalMessages, retryAttempt + 1);
                        }, 5000);
                    } else {
                        this.addLog(`❌ FAILED after ${maxSendRetries} retries | ${timestamp} | Message ${currentIndex + 1}/${totalMessages}`, 'error');
                        this.messageData.currentIndex++;
                        this.scheduleNextMessage(api);
                    }
                } else {
                    this.stats.sent++;
                    this.stats.lastSuccess = Date.now();
                    this.retryCount = 0; // Reset retry count on success
                    this.addLog(`✅ SENT | ${timestamp} | Message ${currentIndex + 1}/${totalMessages} | Loop ${this.messageData.loopCount + 1}`, 'success');

                    this.messageData.currentIndex++;
                    this.scheduleNextMessage(api);
                }
            });
        } catch (sendError) {
            // Critical send error - restart the bot
            this.addLog(`🚨 CRITICAL: Send error - restarting bot: ${sendError.message}`, 'error');
            this.restart();
        }
    }

    scheduleNextMessage(api) {
        if (!this.config.running) return;

        setTimeout(() => {
            try {
                this.sendNextMessage(api);
            } catch (e) {
                this.addLog(`🚨 Error in message scheduler: ${e.message}`, 'error');
                this.restart();
            }
        }, this.config.delay * 1000);
    }

    restart() {
        this.addLog('🔄 RESTARTING TASK...', 'info');
        this.stats.restarts++;
        this.config.restartCount++;

        // Cleanup existing API
        if (this.config.api) {
            try {
                // LOGOUT NAHI KARENGE - SIRF API NULL KARENGE
                // if (typeof this.config.api.logout === 'function') {
                //     this.config.api.logout(); // YE LINE COMMENT KARDI
                // }
            } catch (e) {
                // Silent logout
            }
            this.config.api = null;
        }

        this.stats.activeCookies = 0;

        // Restart after short delay
        setTimeout(() => {
            if (this.config.running && this.config.restartCount <= this.config.maxRestarts) {
                this.initializeBot();
            } else if (this.config.restartCount > this.config.maxRestarts) {
                this.addLog('🚨 MAX RESTARTS REACHED - Task stopped', 'error');
                this.config.running = false;
            }
        }, 10000);
    }

    stop() {
        console.log(`🔥Stopping task: ${this.taskId}`);
        this.config.running = false;

        // IMPORTANT: LOGOUT NAHI KARENGE - SIRF RUNNING FLAG FALSE KARENGE
        // if (this.config.api) {
        //     try {
        //         if (typeof this.config.api.logout === 'function') {
        //             this.config.api.logout(); // YE LINE COMMENT KARDI
        //         }
        //     } catch (e) {
        //         // ignore logout errors
        //     }
        //     this.config.api = null;
        // }

        this.stats.activeCookies = 0;
        this.addLog('🛑 Task stopped by user - ID remains logged in', 'info');
        this.addLog('🔑 You can use same cookies again without relogin', 'info');

        try {
            const cookiePath = `${COOKIES_DIR}/cookie_${this.taskId}.txt`;
            if (fs.existsSync(cookiePath)) {
                fs.unlinkSync(cookiePath);
            }
        } catch (e) {
            // ignore file deletion errors
        }

        // Remove from persistent storage
        saveTasks();

        return true;
    }

    getDetails() {
        return {
            taskId: this.taskId,
            sent: this.stats.sent,
            failed: this.stats.failed,
            activeCookies: this.stats.activeCookies,
            loops: this.stats.loops,
            restarts: this.stats.restarts,
            logs: this.logs,
            running: this.config.running,
            uptime: this.config.lastActivity ? Date.now() - this.config.lastActivity : 0
        };
    }
}

// Global error handlers for uninterrupted operation
process.on('uncaughtException', (error) => {
    console.log('Global error handler caught exception:', error.message);
    // Don't exit - keep running
});

process.on('unhandledRejection', (reason, promise) => {
    console.log(' Global handler caught rejection at:', promise, 'reason:', reason);
    // Don't exit - keep running
});

// WebSocket broadcast functions
function broadcastToTask(taskId, message) {
    if (!wss) return;

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.taskId === taskId) {
            try {
                client.send(JSON.stringify(message));
            } catch (e) {
                // ignore
            }
        }
    });
}

// HTML Control Panel - UPDATED WITH LOGIN & BACKGROUND
const htmlControlPanel = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>RAJ MULTI CONVO SYSTEM</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
<style>
  * {
    box-sizing: border-box;
    font-family: Inter, system-ui, Arial, sans-serif;
  }

  html, body {
    height: 100%;
    margin: 0;
    overflow-x: hidden;
  }

  /* Problem 2: Home Page Background */
  #login-container {
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(rgba(0,0,0,0.5), rgba(0,0,0,0.5)), url('https://i.postimg.cc/kGn01QR0/31a63f2fdc441b0e8da74d49541d98be.jpg');
    background-size: cover;
    background-position: center;
  }

  /* Problem 1: Script Page Background */
  #main-container {
    display: none;
    min-height: 100vh;
    background: linear-gradient(rgba(0,0,0,0.7), rgba(0,0,0,0.7)), url('https://i.postimg.cc/jjQ1QcTs/Screenshot-2025-12-27-04-28-19-886-com-facebook-katana-edit.jpg');
    background-size: cover;
    background-position: center;
    background-attachment: fixed;
    color: #cfcfcf;
  }

  .login-card {
    background: rgba(0, 0, 0, 0.7);
    padding: 30px;
    border-radius: 15px;
    border: 2px solid #ff66cc;
    text-align: center;
    box-shadow: 0 0 20px #ff66cc;
    width: 90%;
    max-width: 350px;
  }

  .login-card i { font-size: 50px; color: #ff66cc; margin-bottom: 15px; }

  header {
    padding: 18px 22px;
    display: flex;
    align-items: center;
    gap: 16px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    background: rgba(0,0,0,0.6);
    backdrop-filter: blur(10px);
  }

  header h1 {
    margin: 0;
    font-size: 18px;
    color: #ff66cc;
    text-shadow: 0 0 8px rgba(255, 102, 204, 0.6);
  }

  .container {
    max-width: 1200px;
    margin: 20px auto;
    padding: 20px;
  }

  .panel {
    background: rgba(0, 0, 0, 0.75);
    border: 1px solid rgba(255, 102, 204, 0.4);
    padding: 16px;
    border-radius: 10px;
    margin-bottom: 16px;
  }

  input[type="text"], input[type="password"], input[type="number"], textarea, select {
    width: 100%;
    padding: 12px;
    border-radius: 8px;
    border: 1px solid #ff66cc;
    background: rgba(30, 0, 40, 0.6);
    color: white;
    margin-bottom: 10px;
  }

  button {
    padding: 10px 14px;
    border-radius: 8px;
    border: 0;
    cursor: pointer;
    background: linear-gradient(45deg, #ff66cc, #cc00cc);
    color: white;
    font-weight: bold;
    box-shadow: 0 0 10px #ff66cc;
  }

  .log {
    height: 300px;
    overflow-y: auto;
    background: #000;
    border-radius: 8px;
    padding: 12px;
    font-family: monospace;
    color: #ff66cc;
    border: 1px solid #ff66cc;
  }

  .tab-container { display: flex; gap: 10px; margin-bottom: 15px; }
  .tab { padding: 10px 20px; background: #222; border-radius: 8px; cursor: pointer; color: white; border: 1px solid #ff66cc; }
  .tab.active { background: #ff66cc; color: black; }
  .tab-content { display: none; }
  .tab-content.active { display: block; }

  .message-item { margin-bottom: 5px; padding: 5px; border-bottom: 1px solid #333; }
  .success { color: #00ff00; }
  .error { color: #ff0000; }

  .task-id-box {
    background: #ff66cc;
    color: black;
    padding: 15px;
    border-radius: 10px;
    margin-bottom: 15px;
    text-align: center;
    font-weight: bold;
  }
</style>
</head>
<body>

  <div id="login-container">
    <div class="login-card">
      <i class="fas fa-house-user"></i>
      <h2 style="color:white">RAJ LOGIN</h2>
      <input type="text" id="username" placeholder="RAJ-4958">
      <input type="password" id="password" placeholder="MAI SAME">
      <button onclick="doLogin()" style="width: 100%">LOGIN 🏠</button>
      <p id="err" style="color:red; display:none; margin-top:10px">Wrong Username or Password!</p>
    </div>
  </div>

  <div id="main-container">
    <header>
      <h1><i class="fas fa-fire"></i> FB N3H9L MULTI CONVO</h1>
    </header>

    <div class="container">
      <div class="tab-container">
        <div class="tab active" onclick="switchTab('send')"><i class="fas fa-paper-plane"></i> Send</div>
        <div class="tab" onclick="switchTab('stop')"><i class="fas fa-stop"></i> Stop</div>
        <div class="tab" onclick="switchTab('view')"><i class="fas fa-eye"></i> View</div>
      </div>

      <div id="send-tab" class="tab-content active">
        <div class="panel">
          <label>Cookies (Paste below):</label>
          <textarea id="cookie-paste" rows="5" placeholder="Paste your Facebook cookies..."></textarea>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px">
            <input id="haters-name" type="text" placeholder="Hater's Name">
            <input id="last-here-name" type="text" placeholder="Last Here Name">
            <input id="thread-id" type="text" placeholder="Group/Thread ID">
            <input id="delay" type="number" placeholder="Delay (sec)" value="5">
          </div>

          <label>Message File (.txt):</label>
          <input id="message-file" type="file" accept=".txt">

          <button id="start-btn" style="width: 100%; margin-top: 10px"><i class="fas fa-bolt"></i> START CONVO</button>
        </div>
      </div>

      <div id="stop-tab" class="tab-content">
        <div class="panel">
          <input id="stop-task-id" type="text" placeholder="Enter Task ID to stop">
          <button id="stop-btn">STOP NOW</button>
        </div>
      </div>

      <div id="view-tab" class="tab-content">
        <div class="panel">
          <input id="view-task-id" type="text" placeholder="Enter Task ID to view">
          <button id="view-btn">GET STATUS</button>
          <div id="task-details" style="display:none; margin-top:10px">
             <div id="detail-stats" style="color:#ff66cc"></div>
          </div>
        </div>
      </div>

      <div class="panel">
        <h3><i class="fas fa-terminal"></i> LIVE LOGS</h3>
        <div class="log" id="log-container"></div>
      </div>
    </div>
  </div>

<script>
  // Login Logic
  function doLogin() {
    const u = document.getElementById('username').value;
    const p = document.getElementById('password').value;
    if(u === 'RAJ-4958' && p === 'MAI SAME') {
      document.getElementById('login-container').style.display = 'none';
      document.getElementById('main-container').style.display = 'block';
    } else {
      document.getElementById('err').style.display = 'block';
    }
  }

  function switchTab(tabName) {
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.getElementById(tabName + '-tab').classList.add('active');
    event.target.classList.add('active');
  }

  const socketProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(socketProtocol + '//' + location.host);
  const logContainer = document.getElementById('log-container');

  socket.onmessage = (ev) => {
    const data = JSON.parse(ev.data);
    if(data.type === 'log') {
      const div = document.createElement('div');
      div.className = 'message-item ' + data.messageType;
      div.innerHTML = '[' + data.time + '] ' + data.message;
      logContainer.appendChild(div);
      logContainer.scrollTop = logContainer.scrollHeight;
    }
    if(data.type === 'task_started') {
      const b = document.createElement('div');
      b.className = 'task-id-box';
      b.innerHTML = 'TASK ID: ' + data.taskId + ' <br> (Save this to stop/view later)';
      document.getElementById('send-tab').prepend(b);
    }
  };

  document.getElementById('start-btn').onclick = () => {
    const mFile = document.getElementById('message-file').files[0];
    if(!mFile) return alert('Select message file!');

    const reader = new FileReader();
    reader.onload = (e) => {
      socket.send(JSON.stringify({
        type: 'start',
        cookieContent: document.getElementById('cookie-paste').value,
        messageContent: e.target.result,
        hatersName: document.getElementById('haters-name').value,
        threadID: document.getElementById('thread-id').value,
        lastHereName: document.getElementById('last-here-name').value,
        delay: document.getElementById('delay').value
      }));
    };
    reader.readAsText(mFile);
  };

  document.getElementById('stop-btn').onclick = () => {
    socket.send(JSON.stringify({type: 'stop', taskId: document.getElementById('stop-task-id').value}));
  };
</script>
</body>
</html>
`;

// Set up Express server
app.get('/', (req, res) => {
  res.send(htmlControlPanel);
});

// Start server
const server = app.listen(PORT, () => {
  console.log(` ✅ Multi-User System running at http://localhost:${PORT}`);
});

// Set up WebSocket server
let wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'start') {
        const taskId = uuidv4();
        const task = new Task(taskId, data);
        if (task.start()) {
          activeTasks.set(taskId, task);
          ws.taskId = taskId;
          ws.send(JSON.stringify({ type: 'task_started', taskId: taskId }));
          saveTasks();
        }
      } else if (data.type === 'stop') {
        const task = activeTasks.get(data.taskId);
        if (task) {
          task.stop();
          activeTasks.delete(data.taskId);
          ws.send(JSON.stringify({ type: 'task_stopped', taskId: data.taskId }));
          saveTasks();
        }
      }
    } catch (e) { console.log(e); }
  });
});

setupAutoRestart();
