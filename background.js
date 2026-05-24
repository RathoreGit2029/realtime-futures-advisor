/**
 * Background Service Worker
 * Proxies API requests and WebSocket connections to bypass page-level CSP blocks on secure pages (Binance).
 */

console.log("🛰️ Binance Futures Advisor Background SW Loaded!");

const tabWebSockets = {};

// Clean up WebSockets when a tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabWebSockets[tabId]) {
    console.log(`🔌 Background SW: Tab ${tabId} closed. Cleaning up WebSocket.`);
    try {
      tabWebSockets[tabId].close();
    } catch(e) {}
    delete tabWebSockets[tabId];
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "OPEN_DASHBOARD") {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
    sendResponse({ success: true });
    return false;
  }

  if (request.type === "CONNECT_WS") {
    const tabId = sender.tab ? sender.tab.id : null;
    if (!tabId) {
      sendResponse({ success: false, error: "No sender tab details" });
      return false;
    }
    console.log(`🔌 Background SW: CONNECT_WS requested for Tab ${tabId}: ${request.url}`);
    
    // Close existing WebSocket for this tab if any
    if (tabWebSockets[tabId]) {
      try {
        tabWebSockets[tabId].close();
      } catch (e) {}
      delete tabWebSockets[tabId];
    }
    
    try {
      const wsInstance = new WebSocket(request.url);
      tabWebSockets[tabId] = wsInstance;
      
      wsInstance.onopen = () => {
        chrome.tabs.sendMessage(tabId, { type: "WS_OPENED" }).catch(() => {});
      };
      
      wsInstance.onmessage = (event) => {
        chrome.tabs.sendMessage(tabId, { type: "WS_MESSAGE", data: event.data }).catch(() => {});
      };
      
      wsInstance.onerror = (err) => {
        chrome.tabs.sendMessage(tabId, { type: "WS_ERROR" }).catch(() => {});
      };
      
      wsInstance.onclose = (event) => {
        if (tabWebSockets[tabId] === wsInstance) {
          chrome.tabs.sendMessage(tabId, { 
            type: "WS_CLOSED", 
            code: event.code, 
            reason: event.reason 
          }).catch(() => {});
          delete tabWebSockets[tabId];
        }
      };
      
      sendResponse({ success: true });
    } catch (err) {
      console.error(`❌ Background SW: Failed to create WebSocket for Tab ${tabId}:`, err);
      sendResponse({ success: false, error: err.message });
    }
    return true; // async sendResponse
  }
  
  if (request.type === "DISCONNECT_WS") {
    const tabId = sender.tab ? sender.tab.id : null;
    if (tabId && tabWebSockets[tabId]) {
      console.log(`🔌 Background SW: DISCONNECT_WS requested for Tab ${tabId}`);
      try {
        tabWebSockets[tabId].close();
      } catch (e) {}
      delete tabWebSockets[tabId];
    }
    sendResponse({ success: true });
    return false;
  }

  if (request.type === "FETCH_LOCAL_API") {
    console.log(`✈️ Proxying fetch: [${request.method || 'GET'}] ${request.url}`);
    
    const headers = { ...(request.headers || {}) };
    if (request.body && (request.method === 'POST' || request.method === 'PUT')) {
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json';
      }
    }

    const fetchOptions = {
      method: request.method || 'GET',
      headers: headers
    };

    if (request.body && (request.method === 'POST' || request.method === 'PUT')) {
      fetchOptions.body = typeof request.body === 'string' 
        ? request.body 
        : JSON.stringify(request.body);
    }

    fetch(request.url, fetchOptions)
      .then(async (response) => {
        const text = await response.text();
        let json = {};
        try {
          json = text ? JSON.parse(text) : {};
        } catch (e) {
          json = { text };
        }
        
        if (!response.ok) {
          const errMsg = json.msg || json.error || json.text || `HTTP Error ${response.status}`;
          console.error(`❌ Proxy error [${response.status}] for ${request.url}:`, errMsg, json);
          sendResponse({ 
            success: false, 
            status: response.status, 
            error: errMsg 
          });
        } else {
          console.log(`✅ Proxy success for ${request.url}`);
          sendResponse({ success: true, data: json });
        }
      })
      .catch((error) => {
        console.error(`❌ Background fetch failed for ${request.url}:`, error);
        sendResponse({ success: false, error: error.message || 'Network fetch failed' });
      });

    return true; // Keep the message channel open for sendResponse
  }
});
