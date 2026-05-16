const express = require('express');
const expressWs = require('express-ws');

const app = express();
expressWs(app);
app.use(express.json());

let esp32ws = null;
let camClients = [];
let appClients = [];
let pendingCapture = null;
let nextBinaryIsCapture = false;

// ═══════════════════════════════════════════
//  ESP32-CAM WebSocket
// ═══════════════════════════════════════════
app.ws('/cam', (ws) => {
  esp32ws = ws;
  console.log('ESP32-CAM connecté');

  ws.on('message', (data) => {
    if (typeof data === 'string') {
      // Message texte = réponse de l'ESP32
      if (data === 'CAPTURE_START') {
        nextBinaryIsCapture = true;
      } else if (data === 'CAPTURE_ERROR' && pendingCapture) {
        pendingCapture.reject(new Error('Capture échouée'));
        pendingCapture = null;
        nextBinaryIsCapture = false;
      }
    } else {
      // Données binaires
      if (nextBinaryIsCapture && pendingCapture) {
        // C'est une photo capturée
        nextBinaryIsCapture = false;
        pendingCapture.resolve(data);
        pendingCapture = null;
      } else {
        // Frame du stream normal
        camClients.forEach((res) => {
          try {
            res.write('--frame\r\n');
            res.write('Content-Type: image/jpeg\r\n\r\n');
            res.write(data);
            res.write('\r\n');
          } catch {}
        });
      }
    }
  });

  ws.on('close', () => {
    console.log('ESP32-CAM déconnecté');
    esp32ws = null;
    if (pendingCapture) {
      pendingCapture.reject(new Error('ESP32 déconnecté'));
      pendingCapture = null;
    }
  });
});

// ═══════════════════════════════════════════
//  App WebSocket (alertes PIR)
// ═══════════════════════════════════════════
app.ws('/events', (ws) => {
  appClients.push(ws);
  ws.on('close', () => {
    appClients = appClients.filter((c) => c !== ws);
  });
});

// ═══════════════════════════════════════════
//  Stream MJPEG local
// ═══════════════════════════════════════════
app.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=frame');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Access-Control-Allow-Origin', '*');
  camClients.push(res);
  req.on('close', () => {
    camClients = camClients.filter((c) => c !== res);
  });
});

// ═══════════════════════════════════════════
//  Alertes PIR (WROOM-32)
// ═══════════════════════════════════════════
app.post('/motion', (req, res) => {
  console.log('Mouvement détecté !');
  const event = JSON.stringify({ type: 'motion', timestamp: Date.now() });
  appClients.forEach((ws) => {
    if (ws.readyState === 1) ws.send(event);
  });
  res.sendStatus(200);
});

// ═══════════════════════════════════════════
//  RELAY STATUS — connexion sans IP
// ═══════════════════════════════════════════
app.get('/relay/status', (req, res) => {
  res.json({
    connected: esp32ws !== null,
    clients: camClients.length,
  });
});

// ═══════════════════════════════════════════
//  RELAY CAPTURE — photo sans IP
// ═══════════════════════════════════════════
app.get('/relay/capture', (req, res) => {
  if (!esp32ws) {
    return res.status(503).json({ error: 'ESP32 non connecté au relay' });
  }
  if (pendingCapture) {
    return res.status(429).json({ error: 'Capture déjà en cours' });
  }

  const timeout = setTimeout(() => {
    if (pendingCapture) {
      pendingCapture = null;
      nextBinaryIsCapture = false;
      res.status(504).json({ error: 'Timeout capture' });
    }
  }, 10000);

  pendingCapture = {
    resolve: (data) => {
      clearTimeout(timeout);
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.send(data);
    },
    reject: (err) => {
      clearTimeout(timeout);
      res.status(500).json({ error: err.message });
    },
  };

  esp32ws.send('CAPTURE');
});

// ═══════════════════════════════════════════
//  RELAY CONTROL — flash/qualité/résolution sans IP
// ═══════════════════════════════════════════
app.get('/relay/control', (req, res) => {
  if (!esp32ws) {
    return res.status(503).json({ error: 'ESP32 non connecté' });
  }
  const { var: varName, val } = req.query;
  if (!varName || val === undefined) {
    return res.status(400).json({ error: 'Paramètres manquants' });
  }
  esp32ws.send(JSON.stringify({ cmd: 'control', var: varName, val: parseInt(val) }));
  res.json({ ok: true });
});

// ═══════════════════════════════════════════
//  Ping anti-sleep
// ═══════════════════════════════════════════
app.get('/ping', (req, res) => res.send('ok'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Relay actif sur port ' + PORT));
